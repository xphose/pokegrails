import type Database from 'better-sqlite3'
import { loadAllPriceHistory, pearsonCorrelation, mean, stddev, recordModelRun } from './shared.js'

export type CointegrationPairCard = {
  id: string
  name: string
  set_name: string | null
  card_number: string
  rarity: string | null
  market_price: number
  image_url: string | null
}

export type CointegrationPair = {
  card_a: CointegrationPairCard
  card_b: CointegrationPairCard
  card_a_id: string
  card_a_name: string
  card_b_id: string
  card_b_name: string
  correlation: number
  p_value_approx: number
  relationship: 'strong' | 'moderate' | 'weak'
}

function synchronizeSeries(
  seriesA: Map<string, number>,
  seriesB: Map<string, number>,
): { pricesA: number[]; pricesB: number[] } {
  const commonDates = [...seriesA.keys()].filter(d => seriesB.has(d)).sort()
  return {
    pricesA: commonDates.map(d => seriesA.get(d)!),
    pricesB: commonDates.map(d => seriesB.get(d)!),
  }
}

function sampleStratified(ids: string[], count: number, db: Database.Database): string[] {
  if (ids.length <= count) return ids

  const prices = db.prepare(
    `SELECT id, market_price FROM cards WHERE id IN (${ids.map(() => '?').join(',')}) AND market_price > 0 ORDER BY market_price DESC`,
  ).all(...ids) as { id: string; market_price: number }[]

  if (prices.length <= count) return prices.map(p => p.id)

  const step = prices.length / count
  const sampled: string[] = []
  for (let i = 0; i < count; i++) {
    sampled.push(prices[Math.min(Math.floor(i * step), prices.length - 1)].id)
  }
  return [...new Set(sampled)]
}

function approxPValue(r: number, n: number): number {
  if (n < 4) return 1
  const t = r * Math.sqrt((n - 2) / (1 - r * r + 1e-10))
  const df = n - 2
  const x = df / (df + t * t)
  return Math.min(1, Math.max(0, x))
}

export function findCointegrationPairs(
  db: Database.Database,
  options: { cardId?: string; minOverlap?: number; limit?: number } = {},
): CointegrationPair[] {
  recordModelRun('cointegration')
  const { cardId, minOverlap = 20, limit = 50 } = options
  const allHistory = loadAllPriceHistory(db)

  type CardRow = { id: string; name: string; image_url: string | null; rarity: string | null; market_price: number; set_name: string | null }
  const cardInfoMap = new Map<string, CardRow>()
  const rows = db.prepare(`
    SELECT c.id, c.name, c.image_url, c.rarity, c.market_price, s.name AS set_name
    FROM cards c LEFT JOIN sets s ON s.id = c.set_id
    WHERE c.market_price > 0
  `).all() as CardRow[]
  for (const r of rows) cardInfoMap.set(r.id, r)

  const dateMaps = new Map<string, Map<string, number>>()
  for (const [cid, history] of allHistory) {
    if (history.length < minOverlap) continue
    const dm = new Map<string, number>()
    for (const h of history) {
      dm.set(h.timestamp.split('T')[0], h.price)
    }
    dateMaps.set(cid, dm)
  }

  const eligibleIds = [...dateMaps.keys()]

  const cardIds = cardId
    ? [cardId]
    : sampleStratified(eligibleIds, 120, db)

  const pairIds = cardId
    ? eligibleIds.filter(id => id !== cardId)
    : cardIds

  const pairs: CointegrationPair[] = []
  const seen = new Set<string>()

  for (const idA of cardIds) {
    const mapA = dateMaps.get(idA)
    if (!mapA) continue
    const infoA = cardInfoMap.get(idA)
    const nameA = infoA?.name ?? idA

    for (const idB of pairIds) {
      if (idA === idB) continue
      const pairKey = [idA, idB].sort().join('|')
      if (seen.has(pairKey)) continue
      seen.add(pairKey)

      const mapB = dateMaps.get(idB)
      if (!mapB) continue
      const infoB = cardInfoMap.get(idB)
      const nameB = infoB?.name ?? idB
      if (nameA === nameB) continue

      const { pricesA, pricesB } = synchronizeSeries(mapA, mapB)
      if (pricesA.length < minOverlap) continue

      const corr = pearsonCorrelation(pricesA, pricesB)
      const absCorr = Math.abs(corr)
      if (absCorr < 0.5) continue

      const pVal = approxPValue(corr, pricesA.length)

      const toCard = (id: string, info: CardRow | undefined): CointegrationPairCard => ({
        id,
        name: info?.name ?? id,
        set_name: info?.set_name ?? null,
        card_number: id.split('-').pop() ?? '',
        rarity: info?.rarity ?? null,
        market_price: info?.market_price ?? 0,
        image_url: info?.image_url ?? null,
      })

      pairs.push({
        card_a: toCard(idA, infoA),
        card_b: toCard(idB, infoB),
        card_a_id: idA,
        card_a_name: nameA,
        card_b_id: idB,
        card_b_name: nameB,
        correlation: Math.round(corr * 1000) / 1000,
        p_value_approx: Math.round(pVal * 10000) / 10000,
        relationship: absCorr > 0.8 ? 'strong' : absCorr > 0.6 ? 'moderate' : 'weak',
      })
    }
  }

  return pairs
    .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation))
    .slice(0, limit)
}
