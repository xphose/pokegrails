import type Database from 'better-sqlite3'
import { config } from '../config.js'

const PC_BASE = 'https://www.pricecharting.com'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
let lastRequest = 0

// PriceCharting is fronted by Cloudflare and rejects bot-like User-Agents
// (`PokeGrails/1.0` got served the "Just a moment..." 403 interstitial 2-out-of-3
// times during a 2026-04-18 prod probe — see git log for the full RCA). Browser
// UAs pass cleanly. Keep this in sync with a recent stable Chrome release.
const PC_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

async function throttledFetch(url: string, minGapMs = 1100): Promise<Response> {
  const elapsed = Date.now() - lastRequest
  if (elapsed < minGapMs) await sleep(minGapMs - elapsed)
  lastRequest = Date.now()
  return fetch(url, {
    headers: {
      'User-Agent': PC_UA,
      Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(20_000),
  })
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[#&'().,:!?]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function extractNumber(cardId: string): string {
  const idx = cardId.lastIndexOf('-')
  return idx >= 0 ? cardId.slice(idx + 1) : cardId
}

/* ── Phase 1: Card → PriceCharting product ID matching ─────── */

interface PcMatch {
  pcId: string
  consoleName: string
  productName: string
  loosePriceDollars: number | null
  salesVolume: number
  gradedPrices: GradedPrices
}

export interface GradedPrices {
  raw: number | null
  grade7: number | null
  grade8: number | null
  grade9: number | null
  grade95: number | null
  psa10: number | null
  bgs10: number | null
}

function pennies(v: unknown): number | null {
  return typeof v === 'number' && v > 0 ? v / 100 : null
}

function extractGradedPrices(d: Record<string, unknown>): GradedPrices {
  return {
    raw: pennies(d['loose-price']),
    grade7: pennies(d['cib-price']),
    grade8: pennies(d['new-price']),
    grade9: pennies(d['graded-price']),
    grade95: pennies(d['box-only-price']),
    psa10: pennies(d['manual-only-price']),
    bgs10: pennies(d['bgs-10-price']),
  }
}

async function matchCard(token: string, name: string, number: string, setName?: string | null): Promise<PcMatch | null> {
  const queryParts = setName ? `${name} #${number} ${setName}` : `${name} #${number}`
  const q = encodeURIComponent(queryParts)
  const url = `${PC_BASE}/api/product?t=${token}&q=${q}`
  const resp = await throttledFetch(url)
  if (!resp.ok) return null
  const d = (await resp.json()) as Record<string, unknown>
  if (d.status !== 'success' || !d.id) return null
  if (d.genre !== 'Pokemon Card') return null
  return {
    pcId: String(d.id),
    consoleName: String(d['console-name'] ?? ''),
    productName: String(d['product-name'] ?? ''),
    loosePriceDollars: pennies(d['loose-price']),
    salesVolume: parseInt(String(d['sales-volume'] ?? '0'), 10) || 0,
    gradedPrices: extractGradedPrices(d),
  }
}

async function fetchPcMeta(token: string, pcId: string): Promise<{ consoleName: string; productName: string; gradedPrices: GradedPrices } | null> {
  const url = `${PC_BASE}/api/product?t=${token}&id=${pcId}`
  const resp = await throttledFetch(url)
  // #region agent log (temporary — verifying Cloudflare UA fix; remove after post-fix verification)
  if (!resp.ok) {
    const head = (await resp.clone().text()).slice(0, 120).replace(/\s+/g, ' ')
    console.log(`[pc-backfill][debug] fetchPcMeta ${pcId} → status=${resp.status} body[:120]="${head}"`)
  } else {
    console.log(`[pc-backfill][debug] fetchPcMeta ${pcId} → status=200 ok`)
  }
  // #endregion
  if (!resp.ok) return null
  const d = (await resp.json()) as Record<string, unknown>
  if (d.status !== 'success') return null
  return {
    consoleName: String(d['console-name'] ?? ''),
    productName: String(d['product-name'] ?? ''),
    gradedPrices: extractGradedPrices(d),
  }
}

/* ── Phase 2: Scrape VGPC.chart_data from product pages ────── */

type ChartPoints = [number, number][]

/**
 * Full PriceCharting `VGPC.chart_data` blob. For Pokémon cards, the series
 * names are repurposed from PriceCharting's video-game schema:
 *   - `used`       → raw / ungraded
 *   - `cib`        → Grade 7
 *   - `new`        → Grade 8
 *   - `graded`     → Grade 9
 *   - `boxonly`    → Grade 9.5
 *   - `manualonly` → PSA 10
 * BGS 10 only ships as a point-in-time value in the product API, not here.
 * Sealed-box pages reuse `used` for condition "used" and `new` for sealed.
 */
interface ChartData {
  used: ChartPoints
  newSealed: ChartPoints
  cib: ChartPoints
  graded: ChartPoints
  boxOnly: ChartPoints
  manualOnly: ChartPoints
}

async function scrapeChart(consoleName: string, productName: string): Promise<ChartData | null> {
  const pageUrl = `${PC_BASE}/game/${slugify(consoleName)}/${slugify(productName)}`
  const resp = await throttledFetch(pageUrl, 1500)
  if (!resp.ok) return null
  const html = await resp.text()
  return extractChartJson(html)
}

async function scrapeChartBySlug(pcSlug: string, suffix: string): Promise<ChartData | null> {
  const pageUrl = `${PC_BASE}/game/${pcSlug}/${suffix}`
  const resp = await throttledFetch(pageUrl, 1500)
  if (!resp.ok) return null
  const html = await resp.text()
  return extractChartJson(html)
}

function extractChartJson(html: string): ChartData | null {
  const marker = 'VGPC.chart_data = '
  const start = html.indexOf(marker)
  if (start < 0) return null
  const end = html.indexOf('};', start)
  if (end < 0) return null
  try {
    const raw = JSON.parse(html.slice(start + marker.length, end + 1)) as Record<string, unknown>
    const asPoints = (k: string): ChartPoints => (Array.isArray(raw[k]) ? (raw[k] as ChartPoints) : [])
    return {
      used: asPoints('used'),
      newSealed: asPoints('new'),
      cib: asPoints('cib'),
      graded: asPoints('graded'),
      boxOnly: asPoints('boxonly'),
      manualOnly: asPoints('manualonly'),
    }
  } catch {
    return null
  }
}

/**
 * Maps VGPC series keys to the grade labels we persist in `card_grade_history`.
 * Keep these labels stable — the API route and UI toggle both key off them.
 */
const GRADE_SERIES: { key: keyof ChartData; grade: string }[] = [
  { key: 'used',       grade: 'raw' },
  { key: 'cib',        grade: 'grade7' },
  { key: 'newSealed',  grade: 'grade8' }, // "new" in the source JSON → Grade 8 for cards
  { key: 'graded',     grade: 'grade9' },
  { key: 'boxOnly',    grade: 'grade95' },
  { key: 'manualOnly', grade: 'psa10' },
]

/* ── Phase 3: Store historical data ────────────────────────── */

function storeCardHistory(db: Database.Database, cardId: string, points: ChartPoints) {
  // Dual-write: `pricecharting_median` is the authoritative PC number;
  // `tcgplayer_market` is also populated (only when the row doesn't already
  // have one) so the existing chart-history query and downstream analytics
  // that key off `tcgplayer_market` keep working until they're migrated to
  // the new per-grade API. The `source` column records that this row came
  // from the PC chart scrape rather than a live TCGPlayer tick.
  const stmt = db.prepare(
    `INSERT INTO price_history (card_id, timestamp, tcgplayer_market, tcgplayer_low, ebay_median, pricecharting_median, source)
     VALUES (@cid, @ts, @tcg, NULL, NULL, @pc, 'pricecharting-chart')
     ON CONFLICT(card_id, timestamp) DO UPDATE SET
       pricecharting_median = excluded.pricecharting_median,
       tcgplayer_market = COALESCE(price_history.tcgplayer_market, excluded.tcgplayer_market),
       source = COALESCE(price_history.source, excluded.source)`,
  )

  const tx = db.transaction(() => {
    for (const [epochMs, pennies] of points) {
      if (!pennies || pennies <= 0) continue
      const dollars = pennies / 100
      const ts = new Date(epochMs).toISOString().split('T')[0] + 'T00:00:00.000Z'
      stmt.run({ cid: cardId, ts, tcg: dollars, pc: dollars })
    }
  })
  tx()
}

/**
 * Store all six PriceCharting grade series (raw / 7 / 8 / 9 / 9.5 / PSA 10)
 * for a single card into `card_grade_history`. Zero-priced points in the
 * series mean "not available on that date" — we skip them so the UI doesn't
 * render straight-to-zero dips.
 */
function storeCardGradeHistory(db: Database.Database, cardId: string, chart: ChartData) {
  const stmt = db.prepare(
    `INSERT INTO card_grade_history (card_id, grade, ts, price, source)
     VALUES (@cid, @grade, @ts, @price, 'pricecharting-chart')
     ON CONFLICT(card_id, grade, ts) DO UPDATE SET price = excluded.price`,
  )
  const tx = db.transaction(() => {
    for (const { key, grade } of GRADE_SERIES) {
      const points = chart[key]
      if (!Array.isArray(points)) continue
      for (const [epochMs, pennies] of points) {
        if (!pennies || pennies <= 0) continue
        const dollars = pennies / 100
        const ts = new Date(epochMs).toISOString().split('T')[0] + 'T00:00:00.000Z'
        stmt.run({ cid: cardId, grade, ts, price: dollars })
      }
    }
  })
  tx()
}

function storeSealedHistory(
  db: Database.Database,
  setId: string,
  productType: string,
  packs: number,
  points: ChartPoints,
) {
  const stmt = db.prepare(
    `INSERT INTO sealed_products (set_id, product_type, source, price, packs, fetched_at)
     VALUES (@sid, @pt, @src, @price, @packs, @at)`,
  )

  const tx = db.transaction(() => {
    for (const [epochMs, pennies] of points) {
      if (!pennies || pennies <= 0) continue
      const dollars = pennies / 100
      const ts = new Date(epochMs).toISOString()
      stmt.run({ sid: setId, pt: productType, src: 'pricecharting-history', price: dollars, packs, at: ts })
    }
  })
  tx()
}

/* ── Sealed product catalog (import from sealedPrices) ─────── */

interface SealedEntry {
  setId: string
  type: 'bb' | 'etb'
  packs: number
  pcSlug?: string
}

const SEALED_CATALOG: SealedEntry[] = [
  { setId: 'sv10', type: 'bb', packs: 36, pcSlug: 'pokemon-scarlet-violet-destined-rivals' },
  { setId: 'sv9', type: 'bb', packs: 36, pcSlug: 'pokemon-scarlet-violet-journey-together' },
  { setId: 'sv8', type: 'bb', packs: 36, pcSlug: 'pokemon-scarlet-violet-surging-sparks' },
  { setId: 'sv7', type: 'bb', packs: 36, pcSlug: 'pokemon-scarlet-violet-stellar-crown' },
  { setId: 'sv6', type: 'bb', packs: 36, pcSlug: 'pokemon-scarlet-violet-twilight-masquerade' },
  { setId: 'sv5', type: 'bb', packs: 36, pcSlug: 'pokemon-scarlet-violet-temporal-forces' },
  { setId: 'sv4', type: 'bb', packs: 36, pcSlug: 'pokemon-scarlet-violet-paradox-rift' },
  { setId: 'sv3', type: 'bb', packs: 36, pcSlug: 'pokemon-scarlet-violet-obsidian-flames' },
  { setId: 'sv2', type: 'bb', packs: 36, pcSlug: 'pokemon-scarlet-violet-paldea-evolved' },
  { setId: 'sv1', type: 'bb', packs: 36, pcSlug: 'pokemon-scarlet-violet' },
  { setId: 'sv8pt5', type: 'etb', packs: 9, pcSlug: 'pokemon-scarlet-violet-prismatic-evolutions' },
  { setId: 'sv6pt5', type: 'etb', packs: 9, pcSlug: 'pokemon-scarlet-violet-shrouded-fable' },
  { setId: 'sv4pt5', type: 'etb', packs: 9, pcSlug: 'pokemon-scarlet-violet-paldean-fates' },
  { setId: 'sv3pt5', type: 'etb', packs: 9, pcSlug: 'pokemon-scarlet-violet-151' },
  { setId: 'swsh12', type: 'bb', packs: 36, pcSlug: 'pokemon-silver-tempest' },
  { setId: 'swsh11', type: 'bb', packs: 36, pcSlug: 'pokemon-lost-origin' },
  { setId: 'swsh10', type: 'bb', packs: 36, pcSlug: 'pokemon-astral-radiance' },
  { setId: 'swsh9', type: 'bb', packs: 36, pcSlug: 'pokemon-brilliant-stars' },
  { setId: 'swsh8', type: 'bb', packs: 36, pcSlug: 'pokemon-fusion-strike' },
  { setId: 'swsh7', type: 'bb', packs: 36, pcSlug: 'pokemon-evolving-skies' },
  { setId: 'swsh6', type: 'bb', packs: 36, pcSlug: 'pokemon-chilling-reign' },
  { setId: 'swsh5', type: 'bb', packs: 36, pcSlug: 'pokemon-battle-styles' },
  { setId: 'swsh4', type: 'bb', packs: 36, pcSlug: 'pokemon-vivid-voltage' },
  { setId: 'swsh3', type: 'bb', packs: 36, pcSlug: 'pokemon-darkness-ablaze' },
  { setId: 'swsh2', type: 'bb', packs: 36, pcSlug: 'pokemon-rebel-clash' },
  { setId: 'swsh1', type: 'bb', packs: 36, pcSlug: 'pokemon-sword-shield' },
  { setId: 'swsh12pt5', type: 'etb', packs: 10, pcSlug: 'pokemon-crown-zenith' },
  { setId: 'pgo', type: 'etb', packs: 10, pcSlug: 'pokemon-pokemon-go' },
  { setId: 'cel25', type: 'etb', packs: 10, pcSlug: 'pokemon-celebrations' },
  { setId: 'swsh45', type: 'etb', packs: 10, pcSlug: 'pokemon-shining-fates' },
  { setId: 'swsh35', type: 'etb', packs: 10, pcSlug: 'pokemon-champions-path' },
  { setId: 'zsv10pt5', type: 'etb', packs: 9, pcSlug: 'pokemon-black-bolt' },
  { setId: 'rsv10pt5', type: 'etb', packs: 9, pcSlug: 'pokemon-white-flare' },
]

const SEALED_SUFFIX: Record<string, string> = { bb: 'booster-box', etb: 'elite-trainer-box' }

/* ── Main orchestrator ─────────────────────────────────────── */

export interface BackfillStats {
  cardsMatched: number
  cardsScraped: number
  sealedScraped: number
  errors: number
  /** Running grade-history row count after this backfill pass. */
  gradeHistoryRows?: number
}

/**
 * Live progress state for an in-flight backfill. Lives in module scope
 * because the backfill runs in-process and a single node serves the
 * admin UI (there's no need for Redis/IPC). If we ever go multi-node
 * this becomes a "latest run on node X" report; the durable counts in
 * `getBackfillStatus` are always read from the DB.
 */
interface BackfillProgress {
  running: boolean
  phase: 'idle' | 'phase1-match' | 'phase2-meta' | 'phase3-chart' | 'phase4-sealed' | 'complete' | 'failed'
  currentIndex: number
  currentTotal: number
  startedAt: number | null
  finishedAt: number | null
  lastError: string | null
  lastStats: BackfillStats | null
  scope: string
}

const progress: BackfillProgress = {
  running: false,
  phase: 'idle',
  currentIndex: 0,
  currentTotal: 0,
  startedAt: null,
  finishedAt: null,
  lastError: null,
  lastStats: null,
  scope: 'none',
}

function setPhase(phase: BackfillProgress['phase'], total = 0): void {
  progress.phase = phase
  progress.currentIndex = 0
  progress.currentTotal = total
}
function tickProgress(index: number): void {
  progress.currentIndex = index
}

export interface BackfillStatus {
  /** True while a backfill is in-flight in this process. */
  running: boolean
  /** Coarse phase label that maps to what the job is doing right now. */
  phase: BackfillProgress['phase']
  /** `{ current: i, total: N }` for the current phase (monotonic within a phase). */
  phaseProgress: { current: number; total: number }
  /** Epoch ms when the last run started, or null if one has never started. */
  startedAt: number | null
  /** Epoch ms when the last run finished, or null if it's still running. */
  finishedAt: number | null
  /** Last fatal error message, if any. */
  lastError: string | null
  /** Last completed run's stats (survives until the next run starts). */
  lastStats: BackfillStats | null
  /** Scope label of the last run (`all`, `setId=sv4pt5`, etc). */
  scope: string
  /** DB-backed durable counts. These are ALWAYS fresh (not cached). */
  durable: {
    cardsTotal: number
    cardsMatched: number
    cardsUnmatched: number
    cardsWithHistory: number
    /** `matched / total` as a 0..1 fraction. */
    percentMatched: number
    /** `withHistory / matched` as a 0..1 fraction. */
    percentScraped: number
    /** Total rows in price_history with a PC source. */
    pcHistoryRows: number
    /** Most recent PC history timestamp — tells operators if data is fresh. */
    latestPcTimestamp: string | null
  }
}

/**
 * Pure read — no side effects. Safe to call from any admin route.
 *
 * "Durable" counts come from the DB (so they're correct across restarts
 * and multi-node deployments). The `running` / `phase` fields come from
 * in-memory state and reflect the CURRENT node's in-flight job only.
 */
export function getBackfillStatus(db: Database.Database): BackfillStatus {
  const cardsTotal = (db.prepare(`SELECT COUNT(*) AS c FROM cards`).get() as { c: number }).c
  const cardsMatched = (
    db.prepare(`SELECT COUNT(*) AS c FROM cards WHERE pricecharting_id IS NOT NULL`).get() as { c: number }
  ).c
  const cardsUnmatched = cardsTotal - cardsMatched
  const cardsWithHistory = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT card_id) AS c FROM price_history WHERE pricecharting_median IS NOT NULL`,
      )
      .get() as { c: number }
  ).c
  const pcHistoryRows = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM price_history WHERE pricecharting_median IS NOT NULL`)
      .get() as { c: number }
  ).c
  const latestRow = db
    .prepare(
      `SELECT MAX(timestamp) AS ts FROM price_history WHERE pricecharting_median IS NOT NULL`,
    )
    .get() as { ts: string | null } | undefined

  return {
    running: progress.running,
    phase: progress.phase,
    phaseProgress: { current: progress.currentIndex, total: progress.currentTotal },
    startedAt: progress.startedAt,
    finishedAt: progress.finishedAt,
    lastError: progress.lastError,
    lastStats: progress.lastStats,
    scope: progress.scope,
    durable: {
      cardsTotal,
      cardsMatched,
      cardsUnmatched,
      cardsWithHistory,
      percentMatched: cardsTotal > 0 ? cardsMatched / cardsTotal : 0,
      percentScraped: cardsMatched > 0 ? cardsWithHistory / cardsMatched : 0,
      pcHistoryRows,
      latestPcTimestamp: latestRow?.ts ?? null,
    },
  }
}

/** Returns true if a backfill is currently running in this process. */
export function isBackfillRunning(): boolean {
  return progress.running
}

export interface BackfillOptions {
  /** Re-scrape even if we already have ≥6 PC rows. Default false. */
  force?: boolean
  /** Restrict to a specific card (e.g. "sv4pt5-232"). Phase 4 (sealed) is skipped. */
  cardId?: string
  /** Restrict to cards in a single set. Phase 4 (sealed) still runs. */
  setId?: string
  /** Cap the number of cards considered (after ordering by market_price DESC). */
  limit?: number
  /** Skip Phase 4 (sealed catalog). Default false. */
  skipSealed?: boolean
}

export async function runPricechartingBackfill(
  db: Database.Database,
  opts: BackfillOptions = {},
): Promise<BackfillStats> {
  const token = config.pricechartingApiKey
  if (!token) {
    console.log('[pc-backfill] No PRICECHARTING_API_KEY configured, aborting')
    return { cardsMatched: 0, cardsScraped: 0, sealedScraped: 0, errors: 0 }
  }

  // Concurrency guard — a second caller returns the empty stats rather
  // than kicking off a parallel scrape. The admin UI relies on this so
  // a double-click can't produce two overlapping jobs.
  if (progress.running) {
    console.log('[pc-backfill] already running — refusing to start a second instance')
    return { cardsMatched: 0, cardsScraped: 0, sealedScraped: 0, errors: 0 }
  }

  progress.running = true
  progress.phase = 'phase1-match'
  progress.startedAt = Date.now()
  progress.finishedAt = null
  progress.lastError = null
  progress.scope = opts.cardId
    ? `cardId=${opts.cardId}`
    : opts.setId
      ? `setId=${opts.setId}`
      : 'ALL'

  try {
    const stats = await runPricechartingBackfillInner(db, opts, token)
    progress.phase = 'complete'
    progress.lastStats = stats
    return stats
  } catch (e) {
    progress.phase = 'failed'
    progress.lastError = String(e)
    throw e
  } finally {
    progress.running = false
    progress.finishedAt = Date.now()
  }
}

async function runPricechartingBackfillInner(
  db: Database.Database,
  opts: BackfillOptions,
  token: string,
): Promise<BackfillStats> {
  console.log('[pc-backfill] ═══════════════════════════════════════')
  console.log('[pc-backfill] PriceCharting Historical Backfill START')
  console.log(
    `[pc-backfill]   scope: ${
      opts.cardId ? `cardId=${opts.cardId}` : opts.setId ? `setId=${opts.setId}` : 'ALL'
    }${opts.limit ? ` limit=${opts.limit}` : ''} force=${!!opts.force} skipSealed=${!!opts.skipSealed}`,
  )
  console.log('[pc-backfill] ═══════════════════════════════════════')

  const stats: BackfillStats = { cardsMatched: 0, cardsScraped: 0, sealedScraped: 0, errors: 0 }

  /* ── Phase 1: Match cards to PriceCharting product IDs ────── */
  const filters: string[] = [`c.name IS NOT NULL`]
  const params: any[] = []
  if (opts.cardId) {
    filters.push(`c.id = ?`)
    params.push(opts.cardId)
  }
  if (opts.setId) {
    filters.push(`c.set_id = ?`)
    params.push(opts.setId)
  }
  const limitClause = opts.limit && opts.limit > 0 ? ` LIMIT ${Math.floor(opts.limit)}` : ''
  const cards = db
    .prepare(
      `SELECT c.id, c.name, c.set_id, c.market_price, c.pricecharting_id, s.name AS set_name
       FROM cards c
       LEFT JOIN sets s ON c.set_id = s.id
       WHERE ${filters.join(' AND ')}
       ORDER BY COALESCE(c.market_price, 0) DESC${limitClause}`,
    )
    .all(...params) as {
    id: string
    name: string
    set_id: string | null
    market_price: number | null
    pricecharting_id: string | null
    set_name: string | null
  }[]

  const updatePcStmt = db.prepare(
    `UPDATE cards SET pricecharting_id = ?, pricecharting_median = ?,
       pc_price_raw = ?, pc_price_grade7 = ?, pc_price_grade8 = ?,
       pc_price_grade9 = ?, pc_price_grade95 = ?, pc_price_psa10 = ?, pc_price_bgs10 = ?
     WHERE id = ?`,
  )
  const pcMeta = new Map<string, { consoleName: string; productName: string }>()
  let alreadyMatched = 0

  console.log(`[pc-backfill] Phase 1: Matching ${cards.length} cards to PriceCharting...`)
  setPhase('phase1-match', cards.length)

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i]
    tickProgress(i + 1)

    if (card.pricecharting_id) {
      alreadyMatched++
      continue
    }

    try {
      const num = extractNumber(card.id)
      const result = await matchCard(token, card.name, num, card.set_name)
      if (result) {
        const g = result.gradedPrices
        updatePcStmt.run(
          result.pcId, result.loosePriceDollars,
          g.raw, g.grade7, g.grade8, g.grade9, g.grade95, g.psa10, g.bgs10,
          card.id,
        )
        pcMeta.set(card.id, { consoleName: result.consoleName, productName: result.productName })
        card.pricecharting_id = result.pcId
        stats.cardsMatched++
      }
    } catch {
      stats.errors++
    }

    if ((i + 1) % 50 === 0 || i === cards.length - 1) {
      console.log(
        `[pc-backfill]   ${i + 1}/${cards.length} — matched: ${stats.cardsMatched}, skipped: ${alreadyMatched}, errors: ${stats.errors}`,
      )
    }
  }

  console.log(`[pc-backfill] Phase 1 done — ${stats.cardsMatched} new + ${alreadyMatched} existing matches`)

  /* ── Phase 2: Fetch metadata for pre-matched cards ──────── */
  const needsMeta = cards.filter((c) => c.pricecharting_id && !pcMeta.has(c.id))

  if (needsMeta.length > 0) {
    console.log(`[pc-backfill] Phase 2a: Fetching metadata for ${needsMeta.length} previously-matched cards...`)
    setPhase('phase2-meta', needsMeta.length)
    for (let i = 0; i < needsMeta.length; i++) {
      const card = needsMeta[i]
      tickProgress(i + 1)
      try {
        const meta = await fetchPcMeta(token, card.pricecharting_id!)
        if (meta) {
          pcMeta.set(card.id, meta)
          const g = meta.gradedPrices
          updatePcStmt.run(
            card.pricecharting_id!, g.raw,
            g.raw, g.grade7, g.grade8, g.grade9, g.grade95, g.psa10, g.bgs10,
            card.id,
          )
        }
      } catch {
        stats.errors++
      }
      if ((i + 1) % 50 === 0) {
        console.log(`[pc-backfill]   metadata ${i + 1}/${needsMeta.length}`)
      }
    }
  }

  /* ── Phase 3: Scrape chart history for all matched cards ── */
  const hasHistStmt = db.prepare(
    `SELECT COUNT(*) as c FROM price_history WHERE card_id = ? AND pricecharting_median IS NOT NULL`,
  )
  const cardsWithMeta = cards.filter((c) => c.pricecharting_id && pcMeta.has(c.id))

  console.log(`[pc-backfill] Phase 3: Scraping charts for ${cardsWithMeta.length} cards...`)
  setPhase('phase3-chart', cardsWithMeta.length)

  for (let i = 0; i < cardsWithMeta.length; i++) {
    const card = cardsWithMeta[i]
    tickProgress(i + 1)
    const meta = pcMeta.get(card.id)!

    const histCount = (hasHistStmt.get(card.id) as { c: number }).c
    if (!opts.force && histCount >= 6) {
      stats.cardsScraped++
      continue
    }

    try {
      const chart = await scrapeChart(meta.consoleName, meta.productName)
      if (chart && chart.used.length > 0) {
        storeCardHistory(db, card.id, chart.used)
        // Also persist all six graded series (raw/7/8/9/9.5/PSA10) into
        // card_grade_history so the UI can toggle between them. `used` is
        // duplicated as 'raw' inside storeCardGradeHistory — the dual write
        // into price_history above remains for backwards compat.
        storeCardGradeHistory(db, card.id, chart)
        stats.cardsScraped++
      }
    } catch {
      stats.errors++
    }

    if ((i + 1) % 25 === 0 || i === cardsWithMeta.length - 1) {
      console.log(
        `[pc-backfill]   ${i + 1}/${cardsWithMeta.length} — scraped: ${stats.cardsScraped}, errors: ${stats.errors}`,
      )
    }
  }

  console.log(`[pc-backfill] Phase 3 done — ${stats.cardsScraped} card charts stored`)

  // Phase 4 runs only for full or set-scoped backfills. Single-card runs are
  // debugging/targeted ops that shouldn't block on the 30+ sealed scrapes.
  if (opts.cardId || opts.skipSealed) {
    console.log(`[pc-backfill] Phase 4 skipped (scope=${opts.cardId ? 'single card' : 'skipSealed'})`)
    stats.gradeHistoryRows = (
      db.prepare(`SELECT COUNT(*) as c FROM card_grade_history`).get() as { c: number }
    ).c
    console.log('[pc-backfill] ═══════════════════════════════════════')
    console.log(
      `[pc-backfill] COMPLETE — matched: ${stats.cardsMatched}, scraped: ${stats.cardsScraped}, ` +
        `grade-history rows: ${stats.gradeHistoryRows}, errors: ${stats.errors}`,
    )
    console.log('[pc-backfill] ═══════════════════════════════════════')
    return stats
  }

  /* ── Phase 4: Sealed product historical prices ────────────── */
  console.log(`[pc-backfill] Phase 4: Scraping sealed product history...`)
  setPhase('phase4-sealed', SEALED_CATALOG.length)

  const existingSealedCount = db.prepare(
    `SELECT COUNT(*) as c FROM sealed_products WHERE source = 'pricecharting-history'`,
  )

  let sealedIdx = 0
  for (const entry of SEALED_CATALOG) {
    tickProgress(++sealedIdx)
    if (!entry.pcSlug) continue
    const suffix = SEALED_SUFFIX[entry.type]
    if (!suffix) continue

    const existing = (
      db
        .prepare(
          `SELECT COUNT(*) as c FROM sealed_products WHERE set_id = ? AND source = 'pricecharting-history'`,
        )
        .get(entry.setId) as { c: number }
    ).c
    if (!opts.force && existing >= 6) {
      stats.sealedScraped++
      continue
    }

    try {
      const chart = await scrapeChartBySlug(entry.pcSlug, suffix)
      if (!chart) continue
      // For sealed products, price data lives in "used" (ungraded/standard condition)
      const points = chart.used.length > 0 ? chart.used : chart.newSealed
      if (points.length > 0) {
        storeSealedHistory(db, entry.setId, entry.type, entry.packs, points)
        stats.sealedScraped++
        console.log(`[pc-backfill]   sealed ${entry.setId} (${entry.type}): ${points.length} data points`)
      }
    } catch {
      stats.errors++
    }
  }

  const totalSealed = (existingSealedCount.get() as { c: number }).c
  console.log(`[pc-backfill] Phase 4 done — ${stats.sealedScraped} sealed products, ${totalSealed} total historical rows`)

  stats.gradeHistoryRows = (db.prepare(`SELECT COUNT(*) as c FROM card_grade_history`).get() as { c: number }).c

  console.log('[pc-backfill] ═══════════════════════════════════════')
  console.log(
    `[pc-backfill] COMPLETE — matched: ${stats.cardsMatched}, scraped: ${stats.cardsScraped}, ` +
      `sealed: ${stats.sealedScraped}, grade-history rows: ${stats.gradeHistoryRows}, errors: ${stats.errors}`,
  )
  console.log('[pc-backfill] ═══════════════════════════════════════')

  return stats
}
