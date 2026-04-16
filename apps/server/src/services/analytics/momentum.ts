import type Database from 'better-sqlite3'
import { loadAllPriceHistory, loadPriceHistory, mean, stddev, recordModelRun, linearRegression } from './shared.js'

export type MomentumCard = {
  card_id: string
  name: string
  set_id: string | null
  set_name: string | null
  card_number: string
  rarity: string | null
  image_url: string | null
  market_price: number
  momentum_score: number
  trend_direction: 'accelerating' | 'steady' | 'decelerating'
  price_change_30d_pct: number
  spark_30d: number[]
  confidence: number
}

export function detectMomentumCards(db: Database.Database, limit = 50): MomentumCard[] {
  recordModelRun('lstm-momentum')
  const allHistory = loadAllPriceHistory(db, 60)
  const cards = db.prepare(`
    SELECT c.id, c.name, c.set_id, c.image_url, c.market_price, c.rarity,
           s.name AS set_name
    FROM cards c
    LEFT JOIN sets s ON s.id = c.set_id
    WHERE c.market_price IS NOT NULL AND c.market_price > 0
  `).all() as { id: string; name: string; set_id: string | null; image_url: string | null; market_price: number; rarity: string | null; set_name: string | null }[]

  const results: MomentumCard[] = []

  for (const card of cards) {
    const history = allHistory.get(card.id)
    if (!history || history.length < 10) continue

    const prices = history.map(h => h.price)
    const recentLen = Math.min(30, prices.length)
    const recent = prices.slice(-recentLen)
    const olderLen = Math.min(30, prices.length - recentLen)
    const older = olderLen >= 5 ? prices.slice(-recentLen - olderLen, -recentLen) : []

    if (recent.length < 3) continue

    const recentTrend = computeTrendStrength(recent)
    const olderTrend = older.length >= 3 ? computeTrendStrength(older) : 0

    const acceleration = recentTrend - olderTrend
    const volatility = stddev(recent) / (mean(recent) || 1)
    const priceChange = recent.length >= 2
      ? (recent[recent.length - 1] - recent[0]) / (recent[0] || 1)
      : 0

    const volumeConsistency = computeVolumeConsistency(recent)

    const trendComponent = Math.tanh(recentTrend * 5) * 30
    const accelComponent = Math.tanh(acceleration * 10) * 20
    const changeComponent = Math.tanh(priceChange * 2) * 25
    const consistencyComponent = (volumeConsistency - 0.5) * 15
    const volatilityPenalty = Math.min(volatility * 10, 10)

    const rawScore = trendComponent + accelComponent + changeComponent + consistencyComponent - volatilityPenalty
    const momentum_score = Math.max(0, Math.min(100, Math.round(50 + rawScore)))

    let trend_direction: MomentumCard['trend_direction'] = 'steady'
    if (acceleration > 0.005 && recentTrend > olderTrend) trend_direction = 'accelerating'
    else if (acceleration < -0.005 && recentTrend < olderTrend) trend_direction = 'decelerating'

    const confidence = Math.min(1, history.length / 30) *
      (1 - Math.min(0.5, volatility))

    const cardNumber = card.id.includes('-') ? card.id.split('-').pop()! : card.id

    results.push({
      card_id: card.id,
      name: card.name,
      set_id: card.set_id,
      set_name: card.set_name,
      card_number: cardNumber,
      rarity: card.rarity,
      image_url: card.image_url,
      market_price: card.market_price,
      momentum_score,
      trend_direction,
      price_change_30d_pct: Math.round(priceChange * 10000) / 100,
      spark_30d: prices.slice(-15),
      confidence: Math.round(confidence * 100) / 100,
    })
  }

  return results
    .filter(r => r.momentum_score > 20)
    .sort((a, b) => b.momentum_score - a.momentum_score)
    .slice(0, limit)
}

function computeTrendStrength(prices: number[]): number {
  if (prices.length < 3) return 0
  const x = prices.map((_, i) => i)
  const reg = linearRegression(x, prices)
  const avgPrice = mean(prices) || 1
  return (reg.slope / avgPrice) * Math.sqrt(reg.rSquared)
}

function computeVolumeConsistency(prices: number[]): number {
  if (prices.length < 3) return 0.5
  let ups = 0
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] > prices[i - 1]) ups++
  }
  return ups / (prices.length - 1)
}

export function getCardMomentum(
  db: Database.Database,
  cardId: string,
): MomentumCard | { error: string } {
  const card = db.prepare(`
    SELECT c.id, c.name, c.set_id, c.image_url, c.market_price, c.rarity, s.name AS set_name
    FROM cards c LEFT JOIN sets s ON s.id = c.set_id WHERE c.id = ?
  `).get(cardId) as { id: string; name: string; set_id: string | null; image_url: string | null; market_price: number; rarity: string | null; set_name: string | null } | undefined
  if (!card) return { error: 'Card not found' }

  const history = loadPriceHistory(db, cardId)
  const cardNumber = card.id.includes('-') ? card.id.split('-').pop()! : card.id

  if (history.length < 10) {
    return {
      card_id: card.id, name: card.name, set_id: card.set_id, set_name: card.set_name,
      card_number: cardNumber, rarity: card.rarity, image_url: card.image_url,
      market_price: card.market_price ?? 0,
      momentum_score: 0, trend_direction: 'steady',
      price_change_30d_pct: 0, spark_30d: [], confidence: 0,
    }
  }

  const prices = history.map(h => h.price)
  const recentLen = Math.min(30, prices.length)
  const recent = prices.slice(-recentLen)
  const olderLen = Math.min(30, prices.length - recentLen)
  const older = olderLen >= 5 ? prices.slice(-recentLen - olderLen, -recentLen) : []

  const recentTrend = computeTrendStrength(recent)
  const olderTrend = older.length >= 3 ? computeTrendStrength(older) : 0
  const acceleration = recentTrend - olderTrend
  const volatility = stddev(recent) / (mean(recent) || 1)
  const priceChange = recent.length >= 2
    ? (recent[recent.length - 1] - recent[0]) / (recent[0] || 1) : 0

  const volumeConsistency = computeVolumeConsistency(recent)
  const trendComponent = Math.tanh(recentTrend * 5) * 30
  const accelComponent = Math.tanh(acceleration * 10) * 20
  const changeComponent = Math.tanh(priceChange * 2) * 25
  const consistencyComponent = (volumeConsistency - 0.5) * 15
  const volatilityPenalty = Math.min(volatility * 10, 10)
  const rawScore = trendComponent + accelComponent + changeComponent + consistencyComponent - volatilityPenalty
  const momentum_score = Math.max(0, Math.min(100, Math.round(50 + rawScore)))

  let trend_direction: MomentumCard['trend_direction'] = 'steady'
  if (acceleration > 0.005 && recentTrend > olderTrend) trend_direction = 'accelerating'
  else if (acceleration < -0.005 && recentTrend < olderTrend) trend_direction = 'decelerating'

  const confidence = Math.min(1, history.length / 30) * (1 - Math.min(0.5, volatility))

  return {
    card_id: card.id, name: card.name, set_id: card.set_id, set_name: card.set_name,
    card_number: cardNumber, rarity: card.rarity, image_url: card.image_url,
    market_price: card.market_price ?? 0, momentum_score, trend_direction,
    price_change_30d_pct: Math.round(priceChange * 10000) / 100,
    spark_30d: prices.slice(-15),
    confidence: Math.round(confidence * 100) / 100,
  }
}
