import { getValidAccessToken, refreshAccessToken, clearTokens } from './auth'

const base = ''

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // getValidAccessToken() proactively refreshes when expiry is <30s away,
  // so optionalAuth endpoints (like /api/cards) don't silently downgrade
  // to free-tier results after 15 minutes of idle browsing.
  let token = await getValidAccessToken()
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...init?.headers as Record<string, string> }
  if (token) headers['Authorization'] = `Bearer ${token}`

  let res = await fetch(`${base}${path}`, { ...init, headers })

  if (res.status === 401 && token) {
    const newToken = await refreshAccessToken()
    if (newToken) {
      headers['Authorization'] = `Bearer ${newToken}`
      res = await fetch(`${base}${path}`, { ...init, headers })
    } else {
      clearTokens()
    }
  }

  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

export type SetMeta = {
  id: string
  name: string | null
  release_date: string | null
  series: string | null
  total_cards: number | null
}

export type CardFiltersMeta = {
  sets: SetMeta[]
  setIds: string[]
  printBuckets: string[]
}

export type CardRow = {
  id: string
  name: string
  set_id: string | null
  rarity: string | null
  card_type: string | null
  image_url: string | null
  pull_cost_score: number | null
  desirability_score: number | null
  predicted_price: number | null
  market_price: number | null
  ebay_median: number | null
  valuation_flag: string | null
  reddit_buzz_score: number | null
  trends_score?: number | null
  explain_json: string | null
  undervalued_since: string | null
  future_value_12m: number | null
  annual_growth_rate: number | null
  pc_price_raw: number | null
  pc_price_grade7: number | null
  pc_price_grade8: number | null
  pc_price_grade9: number | null
  pc_price_grade95: number | null
  pc_price_psa10: number | null
  pc_price_bgs10: number | null
  ai_score?: number
  ai_decision?: 'BUY' | 'WATCH' | 'PASS'
  spark_30d?: { p: number }[]
}

/** Paginated list from GET /api/cards */
export type CardsListResponse = {
  items: CardRow[]
  total: number
  limit: number
  offset: number
  tier_limited?: boolean
}

/**
 * Build a search-engine-friendly query string for a specific card printing.
 * Includes collector number and set name to avoid blending across printings.
 */
export function buildCardSearchQuery(
  name: string,
  cardId: string,
  setName: string | null | undefined,
  suffix = 'pokemon card',
): string {
  const idx = cardId.lastIndexOf('-')
  const num = idx >= 0 ? cardId.slice(idx + 1) : ''
  return [name, num, setName, suffix].filter(Boolean).join(' ')
}

export type CardInvestmentInsight = {
  card_name: string
  set: string
  grade: string
  composite_score: number
  signal_breakdown: {
    momentum: number
    pop_scarcity: number
    sentiment: number
    lifecycle: number
  }
  pokemon_tier: 'S' | 'A' | 'B' | 'C'
  reprint_risk: 'low' | 'medium' | 'high'
  decision: 'BUY' | 'WATCH' | 'PASS'
  investment_horizon: 'short' | 'medium' | 'long'
  fair_value_estimate: number
  negotiation: {
    opening_offer: number
    ideal_price: number
    max_pay: number
    walk_away_script: string
  }
  thesis: string
  red_flags: string[]
  catalyst_events: string[]
  comparable_cards: string[]
}
