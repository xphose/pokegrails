import type Database from 'better-sqlite3'
import { mean, stddev, median, recordModelRun, rarityToNumeric, loadPriceHistory } from './shared.js'

export type BayesianEstimate = {
  estimated_price: number
  market_price: number
  credible_interval_low: number
  credible_interval_high: number
  prior_source: string
  prior_mean: number | null
  num_observations: number
  confidence_label: string
  peer_count: number
}

function computeRecencyWeights(n: number): number[] {
  const halfLife = Math.max(3, n * 0.15)
  const weights: number[] = []
  for (let i = 0; i < n; i++) {
    const age = n - 1 - i
    weights.push(Math.pow(0.5, age / halfLife))
  }
  return weights
}

function buildPeerGroup(
  db: Database.Database,
  setId: string | null,
  rarity: string | null,
  excludeId: string,
): { prices: number[]; source: string } {
  const targetTier = rarityToNumeric(rarity)

  const allCards = db.prepare(`
    SELECT market_price, rarity FROM cards
    WHERE market_price IS NOT NULL AND market_price > 0 AND id != ?
    ${setId ? 'AND set_id = ?' : ''}
  `).all(...(setId ? [excludeId, setId] : [excludeId])) as { market_price: number; rarity: string | null }[]

  const sameTier = allCards.filter(c => rarityToNumeric(c.rarity) === targetTier)
  if (sameTier.length >= 5) {
    const scope = setId ? `set ${setId}` : 'global pool'
    return { prices: sameTier.map(c => c.market_price), source: `${sameTier.length} cards in ${scope} at rarity tier ${targetTier}` }
  }

  const nearTier = allCards.filter(c => Math.abs(rarityToNumeric(c.rarity) - targetTier) <= 1)
  if (nearTier.length >= 5) {
    const scope = setId ? `set ${setId}` : 'global pool'
    return { prices: nearTier.map(c => c.market_price), source: `${nearTier.length} cards in ${scope} at similar rarity` }
  }

  if (setId) {
    return buildPeerGroup(db, null, rarity, excludeId)
  }

  return { prices: allCards.slice(0, 200).map(c => c.market_price), source: `${Math.min(allCards.length, 200)} cards global` }
}

export function bayesianEstimate(
  db: Database.Database,
  cardId: string,
): BayesianEstimate | { error: string } {
  recordModelRun('bayesian')

  const card = db.prepare(`
    SELECT id, name, set_id, rarity, market_price FROM cards WHERE id = ?
  `).get(cardId) as {
    id: string; name: string; set_id: string | null; rarity: string | null; market_price: number | null
  } | undefined

  if (!card) return { error: 'Card not found' }

  const history = loadPriceHistory(db, cardId)
  const observations = history.filter(h => h.price > 0)
  const peerGroup = buildPeerGroup(db, card.set_id, card.rarity, cardId)
  const peerPrices = peerGroup.prices

  const priorMean = peerPrices.length > 0 ? mean(peerPrices) : 5
  const priorStd = peerPrices.length > 1 ? stddev(peerPrices) : priorMean * 0.5
  const priorVar = priorStd ** 2

  let posteriorMean: number
  let posteriorVar: number

  if (observations.length === 0) {
    posteriorMean = priorMean
    posteriorVar = priorVar
  } else {
    const weights = computeRecencyWeights(observations.length)
    const prices = observations.map(h => h.price)

    let wPriceSum = 0, wTotal = 0
    for (let i = 0; i < prices.length; i++) { wPriceSum += weights[i] * prices[i]; wTotal += weights[i] }
    const obsMean = wPriceSum / wTotal

    let wVarNum = 0
    for (let i = 0; i < prices.length; i++) wVarNum += weights[i] * (prices[i] - obsMean) ** 2
    const obsVar = prices.length > 1
      ? Math.max(wVarNum / wTotal, (obsMean * 0.01) ** 2)
      : (priorStd * 0.8) ** 2

    const effectiveN = wTotal
    posteriorVar = 1 / (1 / priorVar + effectiveN / obsVar)
    posteriorMean = posteriorVar * (priorMean / priorVar + effectiveN * obsMean / obsVar)
  }

  const posteriorStd = Math.sqrt(posteriorVar)
  const credibleLow = Math.max(0.01, posteriorMean - 1.96 * posteriorStd)
  const credibleHigh = posteriorMean + 1.96 * posteriorStd

  let confidence_label: string
  if (observations.length >= 20) confidence_label = 'High confidence — substantial price history'
  else if (observations.length >= 5) confidence_label = `Moderate confidence — ${observations.length} price observations`
  else confidence_label = `Low Data — Estimate Based on ${peerPrices.length} Comparable Cards`

  const priorSource = peerGroup.source
  const peerMeanPrice = peerPrices.length > 0 ? Math.round(mean(peerPrices) * 100) / 100 : null

  const marketPrice = card.market_price ?? 0

  return {
    estimated_price: Math.round(posteriorMean * 100) / 100,
    market_price: marketPrice,
    credible_interval_low: Math.round(credibleLow * 100) / 100,
    credible_interval_high: Math.round(credibleHigh * 100) / 100,
    prior_source: priorSource,
    prior_mean: peerMeanPrice,
    num_observations: observations.length,
    confidence_label,
    peer_count: peerPrices.length,
  }
}
