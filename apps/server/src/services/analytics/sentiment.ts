import type Database from 'better-sqlite3'
import { recordModelRun } from './shared.js'

export type SentimentResult = {
  sentiment_score: number
  label: 'positive' | 'neutral' | 'negative'
  signals: string[]
  breakdown: { source: string; score: number; detail: string }[]
}

const POSITIVE_KEYWORDS = [
  'chase', 'rare', 'alt art', 'full art', 'special', 'illustration',
  'secret', 'gold', 'rainbow', 'legendary', 'mythical', 'ultra',
  'premium', 'exclusive', 'limited', 'promo', 'anniversary',
  'charizard', 'pikachu', 'mewtwo', 'eevee', 'umbreon', 'gengar', 'mew',
  'rayquaza', 'lugia', 'alakazam', 'blastoise',
]

const NEGATIVE_KEYWORDS = [
  'common', 'bulk', 'damaged', 'reprint', 'overprinted',
  'trainer', 'energy', 'basic',
]

const RARITY_SENTIMENT: Record<string, number> = {
  'special illustration rare': 0.9,
  'hyper rare': 0.85,
  'illustration rare': 0.7,
  'alternate art': 0.8,
  'full art': 0.6,
  'ultra rare': 0.5,
  'double rare': 0.3,
  'rare holo': 0.1,
  'rare': 0.0,
  'uncommon': -0.2,
  'common': -0.4,
}

function textSentiment(text: string): { score: number; signals: string[] } {
  const lower = text.toLowerCase()
  const signals: string[] = []
  let score = 0

  for (const kw of POSITIVE_KEYWORDS) {
    if (lower.includes(kw)) {
      score += 0.15
      signals.push(`Positive: "${kw}" in card data`)
    }
  }
  for (const kw of NEGATIVE_KEYWORDS) {
    if (lower.includes(kw)) {
      score -= 0.2
      signals.push(`Negative: "${kw}" in card data`)
    }
  }

  return { score: Math.max(-1, Math.min(1, score)), signals }
}

export function analyzeCardSentiment(
  db: Database.Database,
  cardId: string,
): SentimentResult | { error: string } {
  recordModelRun('sentiment')
  const card = db.prepare(`
    SELECT c.id, c.name, c.rarity, c.card_type, c.character_name,
           c.reddit_buzz_score, c.trends_score, c.desirability_score,
           c.market_price, c.predicted_price, c.valuation_flag
    FROM cards c WHERE c.id = ?
  `).get(cardId) as {
    id: string; name: string; rarity: string | null; card_type: string | null
    character_name: string | null; reddit_buzz_score: number | null
    trends_score: number | null; desirability_score: number | null
    market_price: number | null; predicted_price: number | null
    valuation_flag: string | null
  } | undefined

  if (!card) return { error: 'Card not found' }

  const breakdown: SentimentResult['breakdown'] = []
  const allSignals: string[] = []

  const nameText = [card.name, card.rarity, card.card_type, card.character_name].filter(Boolean).join(' ')
  const { score: textScore, signals: textSignals } = textSentiment(nameText)
  breakdown.push({ source: 'Card text analysis', score: textScore, detail: `${textSignals.length} keyword matches` })
  allSignals.push(...textSignals)

  const rarityKey = (card.rarity ?? '').toLowerCase()
  let raritySentiment = 0
  for (const [key, val] of Object.entries(RARITY_SENTIMENT)) {
    if (rarityKey.includes(key)) { raritySentiment = val; break }
  }
  breakdown.push({ source: 'Rarity signal', score: raritySentiment, detail: card.rarity ?? 'unknown' })
  if (raritySentiment > 0.3) allSignals.push(`High-demand rarity: ${card.rarity}`)
  if (raritySentiment < -0.1) allSignals.push(`Low-demand rarity: ${card.rarity}`)

  const buzzNorm = Math.min(1, (card.reddit_buzz_score ?? 0) / 15)
  const redditSentiment = buzzNorm > 0.3 ? buzzNorm * 0.8 : buzzNorm > 0.05 ? buzzNorm * 0.3 : -0.1
  breakdown.push({ source: 'Reddit buzz', score: redditSentiment, detail: `Score: ${card.reddit_buzz_score ?? 0}` })
  if (buzzNorm > 0.3) allSignals.push('Strong Reddit community discussion')

  const trendsNorm = (card.trends_score ?? 5) / 10
  const trendsSentiment = (trendsNorm - 0.5) * 1.2
  breakdown.push({ source: 'Google Trends', score: trendsSentiment, detail: `Score: ${card.trends_score ?? 5}/10` })
  if (trendsNorm > 0.7) allSignals.push('High Google search interest')

  const valuationSentiment = (card.valuation_flag ?? '').includes('UNDERVALUED') ? 0.5
    : (card.valuation_flag ?? '').includes('OVERVALUED') ? -0.3 : 0
  breakdown.push({ source: 'Valuation model', score: valuationSentiment, detail: card.valuation_flag ?? 'N/A' })
  if (valuationSentiment > 0) allSignals.push('Model signals undervalued — bullish')
  if (valuationSentiment < 0) allSignals.push('Model signals overvalued — bearish')

  const composite = (
    textScore * 0.2 +
    raritySentiment * 0.25 +
    redditSentiment * 0.2 +
    trendsSentiment * 0.15 +
    valuationSentiment * 0.2
  )
  const sentiment_score = Math.max(-1, Math.min(1, Math.round(composite * 1000) / 1000))
  const label: SentimentResult['label'] =
    sentiment_score > 0.15 ? 'positive' : sentiment_score < -0.15 ? 'negative' : 'neutral'

  return { sentiment_score, label, signals: allSignals, breakdown }
}

export function getTopSentiment(
  db: Database.Database,
  direction: 'positive' | 'negative',
  limit = 20,
): (SentimentResult & { card_id: string; name: string })[] {
  const cards = db.prepare(`
    SELECT id, name FROM cards WHERE market_price IS NOT NULL AND market_price > 0 LIMIT 500
  `).all() as { id: string; name: string }[]

  const results: (SentimentResult & { card_id: string; name: string })[] = []
  for (const c of cards) {
    const r = analyzeCardSentiment(db, c.id)
    if ('error' in r) continue
    results.push({ ...r, card_id: c.id, name: c.name })
  }

  if (direction === 'positive') {
    results.sort((a, b) => b.sentiment_score - a.sentiment_score)
  } else {
    results.sort((a, b) => a.sentiment_score - b.sentiment_score)
  }

  return results.slice(0, limit)
}
