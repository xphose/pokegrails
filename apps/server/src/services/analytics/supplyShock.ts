import type Database from 'better-sqlite3'
import { loadAllPriceHistory, mean, stddev, recordModelRun } from './shared.js'

export type SupplyShockAlert = {
  card_id: string
  name: string
  set_name: string | null
  card_number: string
  rarity: string | null
  market_price: number
  image_url: string | null
  supply_proxy: number
  price_trend_pct: number
  alert_level: 'high' | 'medium' | 'low'
  explanation: string
}

/**
 * Without PSA pop report data in the DB, we use a supply proxy derived from:
 * - eBay median relative to TCGPlayer (cheaper eBay ≈ more liquid supply)
 * - Rarity tier inversely correlates with print run
 * - Sustained price declines suggest supply outpacing demand
 * - Price volatility can signal supply uncertainty
 */
export function detectSupplyShocks(db: Database.Database): SupplyShockAlert[] {
  recordModelRun('supply-shock')

  const cards = db.prepare(`
    SELECT c.id, c.name, c.image_url, c.market_price, c.ebay_median,
           c.rarity, c.pull_cost_score, c.predicted_price,
           s.name AS set_name
    FROM cards c
    LEFT JOIN sets s ON s.id = c.set_id
    WHERE c.market_price IS NOT NULL AND c.market_price > 0
  `).all() as {
    id: string; name: string; image_url: string | null
    market_price: number; ebay_median: number | null
    rarity: string | null; pull_cost_score: number | null
    predicted_price: number | null; set_name: string | null
  }[]

  const allHistory = loadAllPriceHistory(db)
  const alerts: SupplyShockAlert[] = []

  for (const card of cards) {
    const history = allHistory.get(card.id) ?? []
    if (history.length < 5) continue

    const prices = history.map(h => h.price)
    const halfIdx = Math.max(1, Math.floor(prices.length / 2))
    const recentPrices = prices.slice(halfIdx)
    const olderPrices = prices.slice(0, halfIdx)

    const recentAvg = mean(recentPrices)
    const olderAvg = mean(olderPrices)
    const priceChange = olderAvg > 0 ? (recentAvg - olderAvg) / olderAvg : 0

    const ebayDiscount = card.ebay_median && card.market_price > 0
      ? (card.market_price - card.ebay_median) / card.market_price
      : 0

    const pullCostInverse = 1 - ((card.pull_cost_score ?? 5) / 10)

    const volatility = recentPrices.length >= 3
      ? stddev(recentPrices) / (recentAvg || 1)
      : 0

    let supplyProxy = 0
    if (ebayDiscount > 0.05) supplyProxy += ebayDiscount * 30
    if (pullCostInverse > 0.5) supplyProxy += pullCostInverse * 20
    if (priceChange < -0.05) supplyProxy += Math.abs(priceChange) * 30
    if (volatility > 0.15) supplyProxy += volatility * 10

    if (supplyProxy < 5) continue

    const priceTrendPct = olderAvg > 0 ? priceChange * 100 : 0

    const reasons: string[] = []
    if (ebayDiscount > 0.1) reasons.push('eBay prices significantly below TCGPlayer')
    if (priceChange < -0.05) reasons.push(`Price declined ${Math.round(Math.abs(priceChange) * 100)}% recently`)
    if (pullCostInverse > 0.6) reasons.push('Higher print run rarity tier')
    if (volatility > 0.2) reasons.push('Elevated price volatility')
    if (!reasons.length) reasons.push('Multiple supply indicators trending upward')

    alerts.push({
      card_id: card.id,
      name: card.name,
      set_name: card.set_name,
      card_number: card.id.split('-').pop() ?? '',
      rarity: card.rarity,
      market_price: card.market_price,
      image_url: card.image_url,
      supply_proxy: Math.round(supplyProxy * 10) / 10,
      price_trend_pct: Math.round(priceTrendPct * 10) / 10,
      alert_level: 'low' as const,
      explanation: reasons.join('; '),
    })
  }

  alerts.sort((a, b) => b.supply_proxy - a.supply_proxy)
  const top = alerts.slice(0, 100)

  for (let i = 0; i < top.length; i++) {
    const pct = i / top.length
    top[i].alert_level = pct < 0.2 ? 'high' : pct < 0.5 ? 'medium' : 'low'
  }

  return top
}
