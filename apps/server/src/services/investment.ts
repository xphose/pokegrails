import type Database from 'better-sqlite3'

export type InvestmentCardLike = {
  id: string
  name: string
  set_id: string | null
  rarity: string | null
  predicted_price: number | null
  market_price: number | null
  pull_cost_score: number | null
  desirability_score: number | null
  reddit_buzz_score: number | null
  google_trends_score?: number | null
  future_value_12m?: number | null
  annual_growth_rate?: number | null
}

export type AiDecision = 'BUY' | 'WATCH' | 'PASS'

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

function normScore(v: number | null | undefined): number {
  if (v == null || Number.isNaN(v)) return 0.5
  return clamp01(v / 10)
}

function normBuzz(v: number | null | undefined): number {
  if (v == null || Number.isNaN(v)) return 0
  return clamp01(v / 20)
}

/**
 * Composite buzz signal that blends Reddit mentions with Google Trends.
 * When Reddit buzz is sparse (common), Google Trends provides a baseline.
 */
function compositeBuzz(card: InvestmentCardLike): number {
  const reddit = normBuzz(card.reddit_buzz_score)
  const trends = normScore(card.google_trends_score)
  // Reddit is real-time signal; trends is longer-term. If reddit exists use it more.
  if (reddit > 0.05) return reddit * 0.6 + trends * 0.4
  return trends * 0.7
}

function discountSignal(predicted: number | null, market: number | null): number {
  if (predicted == null || market == null || predicted <= 0) return 0.5
  return clamp01((predicted - market) / predicted)
}

export function computeAiScore(card: InvestmentCardLike): number {
  const momentum = compositeBuzz(card)
  const popScarcityProxy = normScore(card.pull_cost_score)
  const sentiment = clamp01((momentum + normScore(card.desirability_score)) / 2)
  const lifecycle = card.set_id ? 0.55 : 0.45
  const iconTierMult = inferPokemonTierMultiplier(card.name)
  const reprintRisk = inferReprintRisk(card)
  const volatilityPenalty = inferVolatilityPenalty(card)
  const eventBoost = inferCatalystEvent(card) ? 0.15 : 0
  const dealBoost = discountSignal(card.predicted_price, card.market_price) * 0.3

  // Growth signal: future value projection boost
  const growthRate = card.annual_growth_rate ?? 0
  const growthBoost = clamp01(growthRate / 0.25) * 0.25

  const base =
    momentum * 0.15 +
    popScarcityProxy * 0.2 +
    sentiment * 0.2 +
    lifecycle * 0.1 +
    normScore(card.desirability_score) * 0.15 +
    growthBoost * 0.2

  return clamp01(base * iconTierMult * (1 - reprintRisk) * (1 - volatilityPenalty) + eventBoost + dealBoost)
}

export function aiDecision(score: number): AiDecision {
  if (score >= 0.65) return 'BUY'
  if (score >= 0.42) return 'WATCH'
  return 'PASS'
}

export function inferPokemonTier(name: string): 'S' | 'A' | 'B' | 'C' {
  const n = name.toLowerCase()
  const sTier = ['charizard', 'pikachu', 'eevee', 'mewtwo', 'mew', 'gengar', 'umbreon']
  const aTier = ['rayquaza', 'lugia', 'alakazam', 'blastoise', 'venusaur', 'espeon', 'jolteon']
  if (sTier.some((x) => n.includes(x))) return 'S'
  if (aTier.some((x) => n.includes(x))) return 'A'
  if (/(ex|vmax|vstar|gx|alt|illustration|sir|ir)/i.test(name)) return 'B'
  return 'C'
}

export function inferPokemonTierMultiplier(name: string): number {
  const t = inferPokemonTier(name)
  if (t === 'S') return 1.1
  if (t === 'A') return 1.0
  if (t === 'B') return 0.85
  return 0.7
}

export function inferReprintRisk(card: InvestmentCardLike): number {
  const rarity = (card.rarity ?? '').toLowerCase()
  if (rarity.includes('hyper rare') || rarity.includes('illustration') || rarity.includes('alternate')) return 0.2
  if (rarity.includes('trainer')) return 0.9
  if (rarity.includes('ultra')) return 0.6
  return 0.45
}

export function inferVolatilityPenalty(card: InvestmentCardLike): number {
  const p = card.predicted_price ?? 0
  const m = card.market_price ?? 0
  if (p <= 0 || m <= 0) return 0.12
  const cvProxy = Math.abs(m - p) / Math.max(m, p, 0.01)
  return Math.min(0.3, cvProxy * 0.6)
}

export function inferCatalystEvent(card: InvestmentCardLike): string | null {
  const n = card.name.toLowerCase()
  if (n.includes('anniversary')) return 'Anniversary catalyst (<90d)'
  if (n.includes('promo')) return 'Promotional release cycle'
  return null
}

// ---------------------------------------------------------------------------
// Future value projection
// ---------------------------------------------------------------------------

export type FutureValueInput = {
  name: string
  rarity: string | null
  market_price: number | null
  desirability_score: number | null
  google_trends_score: number | null
  reddit_buzz_score: number | null
  set_release_date: string | null
  price_trend_30d: number | null // % change over 30 days (e.g. 0.05 = +5%)
}

/**
 * Base annual appreciation rate driven by character tier + rarity.
 * Based on observed patterns: iconic characters in premium rarities
 * consistently appreciate; commons/bulk depreciate.
 */
function baseAppreciationRate(tier: 'S' | 'A' | 'B' | 'C', rarity: string | null): number {
  const r = (rarity ?? '').toLowerCase()
  const isChase =
    r.includes('special illustration') || r.includes('alternate') || r.includes('hyper rare')
  const isUltra = r.includes('ultra') || r.includes('full art') || r.includes('illustration')

  if (tier === 'S') return isChase ? 0.22 : isUltra ? 0.15 : 0.08
  if (tier === 'A') return isChase ? 0.16 : isUltra ? 0.10 : 0.04
  if (tier === 'B') return isChase ? 0.10 : isUltra ? 0.05 : 0.0
  return isChase ? 0.04 : -0.03
}

/**
 * Set age multiplier: very new sets depreciate from initial hype,
 * then appreciate once they go out of print.
 */
function ageMultiplier(releaseDateStr: string | null): number {
  if (!releaseDateStr) return 1.0
  const rel = new Date(releaseDateStr)
  if (Number.isNaN(rel.getTime())) return 1.0
  const months = Math.max(
    0,
    (Date.now() - rel.getTime()) / (30.44 * 24 * 60 * 60 * 1000),
  )
  if (months < 3) return 0.6 // initial hype price drop
  if (months < 6) return 0.8
  if (months < 12) return 1.0
  if (months < 24) return 1.15 // out-of-print appreciation
  if (months < 48) return 1.25 // collector demand peaks
  return 1.1 // very old, slower growth
}

/**
 * Estimate 12-month future value and annualized growth rate.
 * Combines character popularity, rarity scarcity, trends momentum,
 * set lifecycle, and recent price trajectory.
 */
export function computeFutureValue(input: FutureValueInput): {
  futureValue12m: number
  annualGrowthRate: number
} {
  const market = input.market_price
  if (market == null || market <= 0) {
    return { futureValue12m: 0, annualGrowthRate: 0 }
  }

  const tier = inferPokemonTier(input.name)
  let rate = baseAppreciationRate(tier, input.rarity)

  // Google Trends boost: high interest = more demand = more appreciation
  const trendsScore = input.google_trends_score ?? 5
  const trendsMult = 0.85 + (trendsScore / 10) * 0.3 // 0.85–1.15
  rate *= trendsMult

  // Reddit buzz boost: active discussion = growing awareness
  const buzzNorm = Math.min(1, (input.reddit_buzz_score ?? 0) / 20)
  rate += buzzNorm * 0.06

  // Set age effect
  rate *= ageMultiplier(input.set_release_date)

  // Price momentum: if already trending up, that tends to continue
  const trend30d = input.price_trend_30d ?? 0
  if (trend30d > 0.02) rate += Math.min(0.08, trend30d * 0.5) // trending up
  else if (trend30d < -0.05) rate *= 0.7 // declining — dampen growth expectation

  // Desirability boost: cards people want have pricing power
  const des = input.desirability_score ?? 5
  rate *= 0.9 + (des / 10) * 0.2 // 0.9–1.1

  // Clamp to reasonable range
  rate = Math.max(-0.15, Math.min(0.40, rate))

  const futureValue12m = market * (1 + rate)
  return {
    futureValue12m: Math.round(futureValue12m * 100) / 100,
    annualGrowthRate: Math.round(rate * 10000) / 10000,
  }
}

/**
 * Negotiation price tiers.
 * `anchor` = the reference price buyers actually compete against (market).
 * `fairValue` = model estimate (may differ from market).
 * `sentimentDelta` = centered around 0 (negative = bearish, positive = bullish).
 *
 * When model fair < market (overvalued), we discount from market toward fair.
 * When model fair >= market (undervalued), we discount from fair.
 * Bands widen for expensive cards because sellers expect negotiation room.
 */
export function buildNegotiation(
  fairValue: number,
  sentimentDelta = 0,
  marketPrice: number | null = null,
): {
  opening_offer: number
  ideal_price: number
  max_pay: number
  walk_away_script: string
} {
  const market = marketPrice != null && marketPrice > 0 ? marketPrice : fairValue
  const anchor = Math.max(fairValue, market)

  // Wider bands for expensive cards (big-ticket items have more negotiation room)
  const tier = anchor > 500 ? 0.03 : anchor > 100 ? 0.02 : anchor > 30 ? 0.01 : 0
  const sentAdj = sentimentDelta < 0 ? -0.02 : sentimentDelta > 0.2 ? 0.01 : 0
  const adj = tier + sentAdj

  const opening = anchor * (0.80 - adj)
  const ideal = anchor * (0.87 - adj * 0.5)
  const max = anchor * (0.93)

  return {
    opening_offer: Math.max(0, Number(opening.toFixed(2))),
    ideal_price: Math.max(0, Number(ideal.toFixed(2))),
    max_pay: Math.max(0, Number(max.toFixed(2))),
    walk_away_script: 'I can move fast at this number today, but I have to stay disciplined on my cap.',
  }
}

export function buildComparableCards(db: Database.Database, card: InvestmentCardLike): string[] {
  if (!card.set_id) return []
  const rows = db
    .prepare(
      `SELECT name
       FROM cards
       WHERE id != ?
         AND set_id = ?
         AND (rarity = ? OR (? IS NULL AND rarity IS NULL))
         AND market_price IS NOT NULL
       ORDER BY ABS(COALESCE(predicted_price, market_price) - COALESCE(?, market_price)) ASC
       LIMIT 3`,
    )
    .all(card.id, card.set_id, card.rarity, card.rarity, card.predicted_price) as { name: string }[]
  return rows.map((r) => r.name)
}

export function buildThesis(card: InvestmentCardLike, score: number): string {
  const decision = aiDecision(score)
  const fair = card.predicted_price ?? 0
  const market = card.market_price ?? 0
  const growth = card.annual_growth_rate ?? 0
  const fv12 = card.future_value_12m ?? 0
  const gapPct = fair > 0 && market > 0 ? ((fair - market) / fair) * 100 : 0

  const growthNote =
    growth >= 0.1 && fv12 > market
      ? ` Projected 12-month value of $${fv12.toFixed(0)} (+${(growth * 100).toFixed(0)}% annual growth) makes this a compelling hold.`
      : ''

  if (decision === 'BUY') {
    return `${card.name} screens as a buy with model fair above current market by ${gapPct.toFixed(1)}%. The setup combines above-average desirability with manageable reprint/volatility risk.${growthNote}`
  }
  if (decision === 'WATCH') {
    return `${card.name} is close to buy quality but needs a better entry. Momentum and demand are decent, yet the current ask leaves limited margin of safety.${growthNote}`
  }
  return `${card.name} does not clear the current edge threshold. The risk-adjusted spread to fair value is too thin versus alternatives on the board.${growthNote || (growth > 0.05 ? ` However, growth projection of +${(growth * 100).toFixed(0)}% suggests some upside potential for patient holders.` : '')}`
}
