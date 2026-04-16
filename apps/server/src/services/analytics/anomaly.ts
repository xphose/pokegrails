import type Database from 'better-sqlite3'
import { loadAllPriceHistory, mean, stddev, zScore, recordModelRun } from './shared.js'

export type AnomalyEvent = {
  card_id: string
  name: string
  set_name: string | null
  card_number: string
  rarity: string | null
  market_price: number
  date: string
  price: number
  z_score: number
  type: 'pump' | 'crash' | 'recovery'
  magnitude_pct: number
  image_url: string | null
}

function classifyAnomaly(
  zVal: number,
  priceChange: number,
  recentHistory: number[],
): AnomalyEvent['type'] | null {
  if (Math.abs(zVal) < 2.0) return null

  if (zVal > 2.0 && priceChange > 0.05) {
    const wasDown = recentHistory.length >= 3 &&
      recentHistory[recentHistory.length - 3] > recentHistory[recentHistory.length - 2] * 1.05
    return wasDown ? 'recovery' : 'pump'
  }
  if (zVal < -2.0 && priceChange < -0.05) return 'crash'
  return null
}

export function detectAnomalies(
  db: Database.Database,
  options: { cardId?: string; days?: number } = {},
): AnomalyEvent[] {
  recordModelRun('anomaly')
  const { cardId, days = 30 } = options
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)

  const allHistory = loadAllPriceHistory(db, 60)
  type CardInfo = { id: string; name: string; image_url: string | null; set_name: string | null; rarity: string | null; market_price: number }
  const cardInfoStmt = db.prepare(`
    SELECT c.id, c.name, c.image_url, c.rarity, c.market_price, s.name AS set_name
    FROM cards c LEFT JOIN sets s ON s.id = c.set_id WHERE c.id = ?
  `)
  const allCardsStmt = db.prepare(`
    SELECT c.id, c.name, c.image_url, c.rarity, c.market_price, s.name AS set_name
    FROM cards c LEFT JOIN sets s ON s.id = c.set_id
    WHERE c.market_price IS NOT NULL AND c.market_price > 0
  `)

  const cardsToCheck = cardId
    ? [cardInfoStmt.get(cardId) as CardInfo | undefined].filter(Boolean)
    : (allCardsStmt.all() as CardInfo[])

  const events: AnomalyEvent[] = []
  const seen = new Set<string>()

  for (const card of cardsToCheck) {
    if (!card) continue
    const history = allHistory.get(card.id)
    if (!history || history.length < 10) continue

    const prices = history.map(h => h.price)

    const baselineEnd = Math.max(3, Math.floor(prices.length * 0.5))
    const baselinePrices = prices.slice(0, baselineEnd)
    const baselineMean = mean(baselinePrices)
    const baselineStd = stddev(baselinePrices)

    if (baselineStd === 0 || baselineMean === 0) continue
    const minStd = baselineMean * 0.02
    const effectiveStd = Math.max(baselineStd, minStd)

    for (let i = baselineEnd; i < history.length; i++) {
      const point = history[i]
      const date = point.timestamp.slice(0, 10)
      if (cardId == null && date < cutoff) continue

      const z = zScore(point.price, baselineMean, effectiveStd)
      const prevPrice = prices[i - 1]
      const priceChange = prevPrice > 0 ? (point.price - prevPrice) / prevPrice : 0

      const recentSlice = prices.slice(Math.max(0, i - 5), i + 1)
      const anomalyType = classifyAnomaly(z, priceChange, recentSlice)

      if (anomalyType) {
        const dedupeKey = `${card.id}|${date}`
        if (seen.has(dedupeKey)) continue
        seen.add(dedupeKey)

        const magnitude = baselineMean > 0
          ? Math.abs(point.price - baselineMean) / baselineMean
          : Math.abs(priceChange)

        events.push({
          card_id: card.id,
          name: card.name,
          set_name: card.set_name,
          card_number: card.id.split('-').pop() ?? '',
          rarity: card.rarity,
          market_price: card.market_price,
          date,
          price: point.price,
          z_score: Math.round(z * 100) / 100,
          type: anomalyType,
          magnitude_pct: Math.round(magnitude * 10000) / 100,
          image_url: card.image_url ?? null,
        })
      }
    }
  }

  return events
    .sort((a, b) => b.date.localeCompare(a.date) || Math.abs(b.z_score) - Math.abs(a.z_score))
    .slice(0, 200)
}
