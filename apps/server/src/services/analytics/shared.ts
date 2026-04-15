import type Database from 'better-sqlite3'

export type CardFeatureRow = {
  id: string
  name: string
  set_id: string | null
  rarity: string | null
  card_type: string | null
  character_name: string | null
  market_price: number | null
  predicted_price: number | null
  pull_cost_score: number | null
  desirability_score: number | null
  reddit_buzz_score: number | null
  trends_score: number | null
  ebay_median: number | null
  artwork_hype_score: number | null
  char_premium_score: number | null
  future_value_12m: number | null
  annual_growth_rate: number | null
  set_release_date: string | null
}

export function loadCardFeatures(db: Database.Database): CardFeatureRow[] {
  return db.prepare(`
    SELECT c.id, c.name, c.set_id, c.rarity, c.card_type, c.character_name,
           c.market_price, c.predicted_price, c.pull_cost_score, c.desirability_score,
           c.reddit_buzz_score, c.trends_score, c.ebay_median,
           c.artwork_hype_score, c.char_premium_score,
           c.future_value_12m, c.annual_growth_rate,
           s.release_date AS set_release_date
    FROM cards c
    LEFT JOIN sets s ON s.id = c.set_id
    WHERE c.market_price IS NOT NULL AND c.market_price > 0
  `).all() as CardFeatureRow[]
}

export type PricePoint = { timestamp: string; price: number }

/**
 * Collapse multiple snapshots per day into one point per date,
 * keeping the latest snapshot's price for each day.
 */
function deduplicateDaily(rows: PricePoint[]): PricePoint[] {
  const byDate = new Map<string, PricePoint>()
  for (const r of rows) {
    const date = r.timestamp.slice(0, 10)
    const existing = byDate.get(date)
    if (!existing || r.timestamp > existing.timestamp) {
      byDate.set(date, { timestamp: date, price: r.price })
    }
  }
  return [...byDate.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
}

export function loadPriceHistory(db: Database.Database, cardId: string): PricePoint[] {
  const rows = db.prepare(`
    SELECT timestamp, COALESCE(tcgplayer_market, pricecharting_median) AS price
    FROM price_history
    WHERE card_id = ?
      AND (tcgplayer_market IS NOT NULL OR pricecharting_median IS NOT NULL)
    ORDER BY timestamp ASC
  `).all(cardId) as PricePoint[]
  return deduplicateDaily(rows)
}

export function loadAllPriceHistory(db: Database.Database): Map<string, PricePoint[]> {
  const rows = db.prepare(`
    SELECT card_id, timestamp, COALESCE(tcgplayer_market, pricecharting_median) AS price
    FROM price_history
    WHERE tcgplayer_market IS NOT NULL OR pricecharting_median IS NOT NULL
    ORDER BY card_id, timestamp ASC
  `).all() as (PricePoint & { card_id: string })[]

  const rawByCard = new Map<string, PricePoint[]>()
  for (const r of rows) {
    const arr = rawByCard.get(r.card_id) ?? []
    arr.push({ timestamp: r.timestamp, price: r.price })
    rawByCard.set(r.card_id, arr)
  }

  const map = new Map<string, PricePoint[]>()
  for (const [cardId, raw] of rawByCard) {
    map.set(cardId, deduplicateDaily(raw))
  }
  return map
}

export function extractFeatureVector(card: CardFeatureRow): { labels: string[]; values: number[] } {
  const setAge = card.set_release_date
    ? Math.max(0, (Date.now() - new Date(card.set_release_date).getTime()) / (30.44 * 86_400_000))
    : 12
  const rarityNum = rarityToNumeric(card.rarity)

  const labels = [
    'pull_cost_score', 'desirability_score', 'artwork_hype_score',
    'char_premium_score', 'reddit_buzz_score', 'trends_score',
    'rarity_tier', 'set_age_months', 'market_price', 'price_momentum_30d',
  ]
  const values = [
    card.pull_cost_score ?? 5,
    card.desirability_score ?? 5,
    card.artwork_hype_score ?? 5,
    card.char_premium_score ?? 5,
    card.reddit_buzz_score ?? 0,
    card.trends_score ?? 5,
    rarityNum,
    setAge,
    card.market_price ?? 0,
    card.annual_growth_rate ?? 0,
  ]
  return { labels, values }
}

export function rarityToNumeric(rarity: string | null): number {
  const r = (rarity ?? '').toLowerCase()
  if (r.includes('special illustration')) return 11
  if (r.includes('hyper rare')) return 10
  if (r.includes('rare rainbow') || r.includes('rare secret') || r.includes('shiny ultra')) return 9
  if (r.includes('illustration rare') || r.includes('alternate') || r.includes('alt art')) return 8
  if (r.includes('full art')) return 7
  if (r.includes('rare ultra') || r.includes('ultra rare')) return 6
  if (r.includes('vmax') || r.includes('vstar') || r.includes('double rare')) return 5
  if (r.includes('rare holo') || r.includes('holo rare') || r.includes('trainer gallery')
    || r.includes('radiant') || r.includes('amazing') || r.includes('shiny rare')
    || r.includes('classic collection')) return 4
  if (r.includes('black white') || r.includes('rare')) return 3
  if (r.includes('uncommon')) return 2
  if (r.includes('common')) return 1
  return 3
}

export function mean(arr: number[]): number {
  if (!arr.length) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

export function stddev(arr: number[]): number {
  if (arr.length < 2) return 0
  const m = mean(arr)
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1))
}

export function median(arr: number[]): number {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function normalize(values: number[]): number[] {
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (max === min) return values.map(() => 0)
  return values.map(v => (v - min) / (max - min))
}

export function zScore(value: number, m: number, sd: number): number {
  return sd === 0 ? 0 : (value - m) / sd
}

export type ModelStatus = {
  name: string
  model_id: string
  last_run: string | null
  card_coverage: number
  total_cards: number
  status: 'ready' | 'insufficient_data' | 'not_run'
}

const modelRunTimes = new Map<string, string>()

export function recordModelRun(modelId: string) {
  modelRunTimes.set(modelId, new Date().toISOString())
}

export function getModelRunTime(modelId: string): string | null {
  return modelRunTimes.get(modelId) ?? null
}

/* ── Model run progress tracker ─────────────────────────────── */

export type RunProgress = {
  running: boolean
  current_model: string | null
  completed: { id: string; duration_ms: number }[]
  queued: string[]
  total: number
  started_at: string | null
  elapsed_ms: number
  finished_at: string | null
  error: string | null
}

const runState = {
  running: false,
  current_model: null as string | null,
  completed: [] as { id: string; duration_ms: number }[],
  queued: [] as string[],
  total: 0,
  started_at: null as number | null,
  started_at_iso: null as string | null,
  finished_at: null as string | null,
  step_started_at: 0,
  error: null as string | null,
}

export function getRunProgress(): RunProgress {
  return {
    running: runState.running,
    current_model: runState.current_model,
    completed: [...runState.completed],
    queued: [...runState.queued],
    total: runState.total,
    started_at: runState.started_at_iso,
    elapsed_ms: runState.started_at ? Date.now() - runState.started_at : 0,
    finished_at: runState.finished_at,
    error: runState.error,
  }
}

export function isRunning(): boolean {
  return runState.running
}

export function startRun(total: number, modelIds: string[] = []): boolean {
  if (runState.running) return false
  runState.running = true
  runState.current_model = null
  runState.completed = []
  runState.queued = [...modelIds]
  runState.total = total
  runState.started_at = Date.now()
  runState.started_at_iso = new Date().toISOString()
  runState.finished_at = null
  runState.step_started_at = 0
  runState.error = null
  return true
}

export function updateRunProgress(modelId: string) {
  runState.current_model = modelId
  runState.step_started_at = Date.now()
  runState.queued = runState.queued.filter(id => id !== modelId)
}

export function completeRunStep(modelId: string) {
  const duration = runState.step_started_at ? Date.now() - runState.step_started_at : 0
  runState.completed.push({ id: modelId, duration_ms: duration })
  runState.current_model = null
}

export function finishRun(error?: string) {
  runState.running = false
  runState.current_model = null
  runState.queued = []
  runState.finished_at = new Date().toISOString()
  if (error) runState.error = error
}

export function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length)
  if (n < 3) return 0
  const mx = mean(x.slice(0, n))
  const my = mean(y.slice(0, n))
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx
    const b = y[i] - my
    num += a * b
    dx += a * a
    dy += b * b
  }
  const denom = Math.sqrt(dx * dy)
  return denom === 0 ? 0 : num / denom
}

export function linearRegression(x: number[], y: number[]): { slope: number; intercept: number; rSquared: number } {
  const n = Math.min(x.length, y.length)
  if (n < 2) return { slope: 0, intercept: mean(y), rSquared: 0 }

  const mx = mean(x.slice(0, n))
  const my = mean(y.slice(0, n))
  let ssxy = 0, ssxx = 0, ssyy = 0
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx
    const dy = y[i] - my
    ssxy += dx * dy
    ssxx += dx * dx
    ssyy += dy * dy
  }
  const slope = ssxx === 0 ? 0 : ssxy / ssxx
  const intercept = my - slope * mx
  const rSquared = ssxx === 0 || ssyy === 0 ? 0 : (ssxy * ssxy) / (ssxx * ssyy)
  return { slope, intercept, rSquared }
}
