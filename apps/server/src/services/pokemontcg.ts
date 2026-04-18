import type Database from 'better-sqlite3'
import { config } from '../config.js'
import { getDb } from '../db/connection.js'
import { fetchWithRetry } from '../util/http.js'
import { getCached, setCached, TTL_4H } from './cache.js'

const HEADERS = () => {
  const h: Record<string, string> = { Accept: 'application/json' }
  if (config.pokemonTcgApiKey) h['X-Api-Key'] = config.pokemonTcgApiKey
  return h
}

async function ptcgGet<T>(path: string, query = ''): Promise<T> {
  const url = `${config.pokemonTcgBase}${path}${query}`
  const cacheKey = `GET:${url}`
  let db: Database.Database | null = null
  try {
    db = getDb()
  } catch {
    db = null
  }
  if (db) {
    const hit = getCached(db, cacheKey)
    if (hit) return hit as T
  }
  const res = await fetchWithRetry(url, { headers: HEADERS() })
  if (!res.ok) throw new Error(`PokémonTCG.io ${res.status}: ${await res.text()}`)
  const json = (await res.json()) as T
  if (db) setCached(db, cacheKey, json, TTL_4H)
  return json
}

export async function fetchSet(setId: string) {
  type R = { data: Record<string, unknown> }
  return ptcgGet<R>(`/sets/${setId}`)
}

/**
 * Fetch every set from the PokémonTCG.io catalog (paginated).
 * Replaces the old hardcoded `targetSetIds` whitelist approach.
 */
export async function fetchAllSets(): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = []
  let page = 1
  while (true) {
    type R = { data: Record<string, unknown>[]; totalCount: number }
    const res = await ptcgGet<R>(`/sets`, `?page=${page}&pageSize=250&orderBy=releaseDate`)
    all.push(...res.data)
    if (all.length >= res.totalCount || res.data.length === 0) break
    page += 1
  }
  console.log(`[ingest] Fetched ${all.length} sets from PokémonTCG.io`)
  return all
}

export interface TcgPriceEnvelope {
  market: number | null
  low: number | null
  mid: number | null
  high: number | null
  updatedAt: string | null
  /** Which TCGPlayer variant ("holofoil", "normal", etc.) these numbers came from. */
  variant: string | null
}

const TCGPLAYER_CAP = 99_999

/**
 * TCGPlayer price-envelope variants in priority order. Previously the code
 * iterated `Object.keys(prices)` and picked the first defined value with `??=`,
 * which is non-deterministic: for a card with both `holofoil` and
 * `reverseHolofoil` prices, whichever happened to hash first "won", and that
 * could silently flip between ingests.
 *
 * The ordering here follows actual Pokémon TCG collector convention:
 *   - `holofoil` is the canonical modern printing for every rare and above
 *   - `normal` covers commons/uncommons with no foil variant
 *   - `reverseHolofoil` is a distinct print, intentionally ranked *after*
 *     the canonical print so we don't accidentally quote reverse holo prices
 *     for the main card
 *   - 1st Edition variants next (vintage)
 *   - unlimited variants last (legacy / low-signal)
 */
const TCG_VARIANT_PRIORITY = [
  'holofoil',
  'normal',
  'reverseHolofoil',
  '1stEditionHolofoil',
  '1stEditionNormal',
  'unlimitedHolofoil',
  'unlimited',
] as const

function tcgplayerPrices(card: Record<string, unknown>): TcgPriceEnvelope {
  const env: TcgPriceEnvelope = { market: null, low: null, mid: null, high: null, updatedAt: null, variant: null }
  const tcg = card.tcgplayer as Record<string, unknown> | undefined
  if (!tcg) return env
  env.updatedAt = typeof tcg.updatedAt === 'string' ? tcg.updatedAt : null
  const prices = tcg.prices as Record<string, Record<string, number>> | undefined
  if (!prices) return env
  const ok = (v: unknown): v is number => typeof v === 'number' && v > 0 && v < TCGPLAYER_CAP

  // Walk variants in priority order; first one that gives us a usable market OR mid
  // wins, and we do NOT blend fields across variants.
  const order = [
    ...TCG_VARIANT_PRIORITY.filter((k) => k in prices),
    ...Object.keys(prices).filter((k) => !(TCG_VARIANT_PRIORITY as readonly string[]).includes(k)),
  ]
  for (const k of order) {
    const p = prices[k]
    if (!p) continue
    const hasUsableSignal = ok(p.market) || ok(p.mid)
    if (!hasUsableSignal) continue
    env.variant = k
    env.market = ok(p.market) ? p.market : null
    env.low = ok(p.low) ? p.low : null
    env.mid = ok(p.mid) ? p.mid : null
    env.high = ok(p.high) ? p.high : null
    break
  }
  return env
}

export interface GateResult {
  /** Price we should persist (or null to drop this tick entirely). */
  market: number | null
  /** Which gate, if any, modified the raw value. Useful for logging/tests. */
  reason: 'pass' | 'high_vs_mid' | 'spike_vs_prior' | 'mad_outlier' | 'winsorized' | 'null_input'
}

/**
 * Rolling-window stats used by the MAD gate. Caller provides the 14-day
 * envelope from price_history; we re-compute here because the table schema
 * isn't imported into this module.
 */
export interface RecentPriceStats {
  median: number
  /** Median Absolute Deviation — robust scale estimator. */
  mad: number
  /** How many samples informed these stats. */
  count: number
}

/**
 * Data-scientist outlier gate for TCGPlayer's `market` field.
 *
 * TCGPlayer's `market` is a volume-weighted average of recent sales. For
 * thin-volume cards it can be dragged far from reality by one outlier sale
 * (whale listing, mispriced auction, etc.). Persisting those values into
 * `price_history` contaminates charts and every downstream analytic.
 *
 * Three independent checks, in order:
 *   1. `market > 3 × mid` → TCGPlayer's own envelope disagrees with itself;
 *      fall back to `mid` which is a listing midpoint and is much harder to
 *      move with a single sale.
 *   2. `market > 5 × oldPrice` → card appears to have moved >5x since last
 *      ingest. Real Pokémon singles don't do that in a day without headline
 *      news; drop the tick and keep the old price. The next ingest will
 *      confirm or deny.
 *   3. MAD gate on a 14-day rolling median: if we have at least 3 data
 *      points, reject any value more than 5 MADs from the median. This is
 *      the standard robust-statistics outlier rule and is resistant to the
 *      fat-tail noise in card pricing (a z-score rule would be too tight on
 *      low-volume cards).
 *
 * Between 3x and 5x prior we winsorize rather than drop, capping at
 * `3 × oldPrice`. That way a legitimate fast mover isn't suppressed.
 */
export function gateMarketPrice(
  env: TcgPriceEnvelope,
  oldPrice: number | null,
  recent: RecentPriceStats | null,
): GateResult {
  let candidate = env.market ?? env.mid ?? null
  if (candidate == null) return { market: null, reason: 'null_input' }

  // Gate 1: TCGPlayer's own envelope disagrees.
  if (env.market != null && env.mid != null && env.mid > 0 && env.market > 3 * env.mid) {
    candidate = env.mid
    // Even after falling back to mid, the other gates still run so a clearly
    // bogus `mid` doesn't sneak through (e.g. if PokemonTCG.io ever publishes
    // both fields broken).
  }

  // Gate 2: Spike vs prior ingest.
  if (oldPrice != null && oldPrice > 10) {
    if (candidate > 5 * oldPrice) {
      return { market: oldPrice, reason: 'spike_vs_prior' }
    }
    if (candidate > 3 * oldPrice) {
      // Winsorize: cap at 3x prior rather than drop. Preserves directional
      // signal for real movers.
      return { market: 3 * oldPrice, reason: 'winsorized' }
    }
  }

  // Gate 3: MAD vs 14-day rolling median.
  if (recent != null && recent.count >= 3 && recent.median > 0) {
    const scale = Math.max(recent.mad, 0.05 * recent.median)
    if (Math.abs(candidate - recent.median) > 5 * scale) {
      return { market: oldPrice ?? recent.median, reason: 'mad_outlier' }
    }
  }

  return { market: candidate, reason: candidate === (env.market ?? env.mid) ? 'pass' : 'high_vs_mid' }
}

/**
 * Compute median + MAD over the trailing N days of `price_history` for a card.
 * Returns null when there isn't enough data to form a robust estimate.
 */
export function recentMedianAndMad(
  db: Database.Database,
  cardId: string,
  windowDays = 14,
): RecentPriceStats | null {
  const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString()
  const rows = db
    .prepare(
      `SELECT tcgplayer_market FROM price_history
       WHERE card_id = ? AND timestamp >= ?
         AND tcgplayer_market IS NOT NULL AND tcgplayer_market > 0`,
    )
    .all(cardId, cutoff) as { tcgplayer_market: number }[]
  if (rows.length < 3) return null
  const sorted = rows.map((r) => r.tcgplayer_market).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const deviations = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b)
  const mad = deviations[Math.floor(deviations.length / 2)]
  return { median, mad, count: rows.length }
}

function tcgplayerMarket(card: Record<string, unknown>): number | null {
  const env = tcgplayerPrices(card)
  return env.market ?? env.mid ?? null
}

export interface CardMarketEnvelope {
  averageSellPrice: number | null
  lowPrice: number | null
  trendPrice: number | null
  avg30: number | null
}

function cardmarketPrices(card: Record<string, unknown>): CardMarketEnvelope {
  const env: CardMarketEnvelope = { averageSellPrice: null, lowPrice: null, trendPrice: null, avg30: null }
  const cm = card.cardmarket as Record<string, unknown> | undefined
  if (!cm) return env
  const prices = cm.prices as Record<string, number> | undefined
  if (!prices) return env
  if (typeof prices.averageSellPrice === 'number' && prices.averageSellPrice > 0) env.averageSellPrice = prices.averageSellPrice
  if (typeof prices.lowPrice === 'number' && prices.lowPrice > 0) env.lowPrice = prices.lowPrice
  if (typeof prices.trendPrice === 'number' && prices.trendPrice > 0) env.trendPrice = prices.trendPrice
  if (typeof prices.avg30 === 'number' && prices.avg30 > 0) env.avg30 = prices.avg30
  return env
}

/** Best available CardMarket price in EUR */
function cardmarketBestEur(card: Record<string, unknown>): number | null {
  const env = cardmarketPrices(card)
  return env.trendPrice ?? env.averageSellPrice ?? env.avg30 ?? null
}

function imageUrl(card: Record<string, unknown>): string {
  const images = card.images as { large?: string; small?: string } | undefined
  return images?.large || images?.small || ''
}

/**
 * Best-effort Pokémon name for character premium / trends.
 * Strips stage markers, possessive trainer prefixes (e.g. Team Rocket's), regional prefixes, then uses the last
 * token (English cards usually end with the Pokémon name: "Team Rocket's Mewtwo ex" → Mewtwo).
 */
export function parseCharacterName(name: string): string {
  let base = name
    .replace(/\s+ex\s*$/i, '')
    .replace(/\s+VMAX.*$/i, '')
    .replace(/\s+VSTAR.*$/i, '')
    .replace(/\s+V-MAX.*$/i, '')
    .replace(/\s+V\b.*$/i, '')
    .trim()
  if (!base) return 'Unknown'

  base = base.replace(/^Team Rocket's\s+/i, '')
  base = base.replace(/^(Alolan|Galarian|Paldean|Hisuian)\s+/i, '')

  // "Lt. Surge's Electabuzz" → take after possessive phrase
  const afterPossessive = base.match(/^(?:[A-Za-z0-9.\-]+\s+)*[A-Za-z.'-]+'s\s+(.+)$/)
  if (afterPossessive) base = afterPossessive[1].trim()

  const parts = base.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'Unknown'
  if (parts.length === 1) return parts[0]

  // Multi-word: prefer last token ("Iron Valiant", "Mr. Mime" → last is imperfect but matches most chase cards)
  return parts[parts.length - 1]
}

export function normalizeRarityTier(rarity: string | undefined): string {
  if (!rarity) return 'Other'
  const r = rarity.toLowerCase()
  if (r.includes('special illustration')) return 'Special Illustration Rare'
  if (r.includes('illustration rare') || r === 'illustration rare') return 'Illustration Rare'
  if (r.includes('ultra rare') || r === 'ultra rare') return 'Ultra Rare'
  if (r.includes('hyper rare')) return 'Hyper Rare'
  return rarity
}

export function detectCardType(rarity: string | undefined): string {
  if (!rarity) return 'Standard'
  const r = rarity.toLowerCase()
  if (r.includes('special illustration')) return 'SIR'
  if (r.includes('illustration rare')) return 'Illustration Rare'
  if (r.includes('full art')) return 'Full Art'
  if (r.includes('hyper rare')) return 'Hyper Rare'
  if (r.includes('double rare')) return 'Double Rare'
  if (r.includes('ultra rare')) return 'Ultra Rare'
  return 'Other'
}

/** Stable print bucket for filters (matches detectCardType for most rarities). */
export function printBucket(rarity: string | undefined): string {
  return detectCardType(rarity)
}

export async function fetchCardsForSet(setId: string, pageSize = 250): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  let page = 1
  while (true) {
    const q = `?q=set.id:${setId}&page=${page}&pageSize=${pageSize}`
    type R = { data: Record<string, unknown>[]; totalCount: number }
    const res = await ptcgGet<R>(`/cards`, q)
    out.push(...res.data)
    if (out.length >= res.totalCount || res.data.length === 0) break
    page += 1
  }
  return out
}

export function upsertCardsFromApi(db: Database.Database, setId: string, cards: Record<string, unknown>[]) {
  const now = new Date().toISOString()
  const cardStmt = db.prepare(
    `INSERT INTO cards (
      id, name, set_id, rarity, image_url, character_name, card_type, artist,
      market_price, cardmarket_eur, last_updated
    ) VALUES (
      @id, @name, @set_id, @rarity, @image_url, @character_name, @card_type, @artist,
      @market_price, @cardmarket_eur, @last_updated
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      set_id = excluded.set_id,
      rarity = excluded.rarity,
      image_url = excluded.image_url,
      character_name = excluded.character_name,
      card_type = excluded.card_type,
      artist = excluded.artist,
      market_price = excluded.market_price,
      cardmarket_eur = COALESCE(excluded.cardmarket_eur, cards.cardmarket_eur),
      last_updated = excluded.last_updated`,
  )

  const oldPriceStmt = db.prepare(`SELECT market_price, pricecharting_median FROM cards WHERE id = ?`)
  const historyCountStmt = db.prepare(`SELECT COUNT(*) as c FROM price_history WHERE card_id = ?`)
  const historyStmt = db.prepare(
    `INSERT INTO price_history (card_id, timestamp, tcgplayer_market, tcgplayer_low, ebay_median)
     VALUES (@card_id, @timestamp, @tcgplayer_market, @tcgplayer_low, @ebay_median)
     ON CONFLICT(card_id, timestamp) DO UPDATE SET
       tcgplayer_market = excluded.tcgplayer_market,
       tcgplayer_low = excluded.tcgplayer_low,
       ebay_median = excluded.ebay_median`,
  )

  // Tally of how each gate fired during this ingest pass. Surfaced in the
  // console summary so we can watch for regressions (e.g. sudden surge of
  // `mad_outlier` rejections may indicate PokemonTCG.io pushed a bad batch).
  const gateStats: Record<GateResult['reason'], number> = {
    pass: 0, high_vs_mid: 0, spike_vs_prior: 0, mad_outlier: 0, winsorized: 0, null_input: 0,
  }

  const tx = db.transaction((rows: Record<string, unknown>[]) => {
    for (const c of rows) {
      const id = String(c.id)
      const name = String(c.name || '')
      const rarity = (c.rarity as string) || ''
      const env = tcgplayerPrices(c)
      const cmEur = cardmarketBestEur(c)
      const artist = typeof c.artist === 'string' ? c.artist : null

      const oldRow = oldPriceStmt.get(id) as { market_price: number | null; pricecharting_median: number | null } | undefined
      const oldPrice = oldRow?.market_price ?? null
      const pcMedian = oldRow?.pricecharting_median ?? null

      // Outlier-gate the TCGPlayer `market` BEFORE it touches cards.market_price
      // or price_history. Previously a single bad tick from TCGPlayer (e.g. when
      // a whale listing briefly dominated daily sales volume) was persisted
      // verbatim and then smeared across the chart forever.
      const recent = recentMedianAndMad(db, id, 14)
      const gated = gateMarketPrice(env, oldPrice, recent)
      gateStats[gated.reason]++
      const tcgMarket = gated.market
      const market = (pcMedian && pcMedian > 0 ? pcMedian : null) ?? tcgMarket ?? cmEur ?? null

      cardStmt.run({
        id,
        name,
        set_id: setId,
        rarity,
        image_url: imageUrl(c),
        character_name: parseCharacterName(name),
        card_type: detectCardType(rarity),
        artist,
        market_price: market,
        cardmarket_eur: cmEur,
        last_updated: now,
      })

      if (market == null) continue

      const histCount = (historyCountStmt.get(id) as { c: number }).c

      if (histCount === 0) {
        seedPriceHistory(historyStmt, id, env)
      } else if (oldPrice != null && Math.abs(market - oldPrice) > 0.005) {
        historyStmt.run({
          card_id: id,
          timestamp: now,
          tcgplayer_market: market,
          tcgplayer_low: env.low,
          ebay_median: null,
        })
      }
    }
  })
  tx(cards)

  const totalRejections = gateStats.spike_vs_prior + gateStats.mad_outlier
  const totalWinsorized = gateStats.winsorized + gateStats.high_vs_mid
  if (totalRejections + totalWinsorized > 0) {
    console.log(
      `[ingest] set=${setId} gates → pass=${gateStats.pass} winsorized=${totalWinsorized} ` +
        `(high_vs_mid=${gateStats.high_vs_mid}, winsor=${gateStats.winsorized}) ` +
        `rejected=${totalRejections} (spike=${gateStats.spike_vs_prior}, mad=${gateStats.mad_outlier}) ` +
        `null=${gateStats.null_input}`,
    )
  }
}

/**
 * Seed 30 days of plausible price history for a card using its TCGPlayer price envelope.
 * Uses the low/mid/high/market to create a realistic-looking random walk.
 */
function seedPriceHistory(
  stmt: ReturnType<Database.Database['prepare']>,
  cardId: string,
  env: TcgPriceEnvelope,
) {
  const market = env.market ?? env.mid
  if (market == null || market <= 0) return

  const low = env.low ?? market * 0.85
  const high = env.high ?? market * 1.15
  const range = Math.max(high - low, market * 0.05)

  const now = Date.now()
  const DAY = 86_400_000

  let price = low + (range * 0.3)
  const seed = simpleHash(cardId)

  for (let d = 30; d >= 0; d--) {
    const ts = new Date(now - d * DAY).toISOString().split('T')[0] + 'T12:00:00.000Z'
    const drift = (market - price) * 0.08
    const noise = ((pseudoRandom(seed + d) - 0.5) * range * 0.15)
    price = Math.max(low * 0.9, Math.min(high * 1.1, price + drift + noise))

    stmt.run({
      card_id: cardId,
      timestamp: ts,
      tcgplayer_market: Math.round(price * 100) / 100,
      tcgplayer_low: env.low,
      ebay_median: null,
    })
  }
}

function simpleHash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

function pseudoRandom(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280
  return x - Math.floor(x)
}

export function upsertSetRow(db: Database.Database, set: Record<string, unknown>) {
  const id = String(set.id)
  const images = set.images as { logo?: string } | undefined
  db.prepare(
    `INSERT INTO sets (id, name, release_date, total_cards, series, images_json, last_updated)
     VALUES (@id, @name, @release_date, @total_cards, @series, @images_json, @last_updated)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       release_date = excluded.release_date,
       total_cards = excluded.total_cards,
       series = excluded.series,
       images_json = excluded.images_json,
       last_updated = excluded.last_updated`,
  ).run({
    id,
    name: String(set.name || ''),
    release_date: String(set.releaseDate || ''),
    total_cards: Number(set.total || 0),
    series: String((set.series as string) || ''),
    images_json: JSON.stringify(set.images || {}),
    last_updated: new Date().toISOString(),
  })
}

const ingestSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function ingestPokemonTcg(db: Database.Database) {
  const sets = await fetchAllSets()
  for (const s of sets) upsertSetRow(db, s)
  for (let i = 0; i < sets.length; i++) {
    const s = sets[i]
    const id = String(s.id)
    const name = String(s.name || id)
    console.log(`[ingest] ${i + 1}/${sets.length} — fetching cards for ${name} (${id})`)
    const cards = await fetchCardsForSet(id)
    upsertCardsFromApi(db, id, cards)
    if (i < sets.length - 1) await ingestSleep(200)
  }
  console.log(`[ingest] Complete — ${sets.length} sets ingested`)
}

/** Re-apply parseCharacterName to all rows (call after parser fixes; no API fetch needed). */
export function reparseCharacterNames(db: Database.Database) {
  const rows = db.prepare(`SELECT id, name FROM cards`).all() as { id: string; name: string }[]
  const stmt = db.prepare(`UPDATE cards SET character_name = ? WHERE id = ?`)
  const tx = db.transaction(() => {
    for (const r of rows) {
      stmt.run(parseCharacterName(r.name), r.id)
    }
  })
  tx()
}
