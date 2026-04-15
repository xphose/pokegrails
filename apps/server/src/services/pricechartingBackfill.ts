import type Database from 'better-sqlite3'
import { config } from '../config.js'

const PC_BASE = 'https://www.pricecharting.com'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
let lastRequest = 0

async function throttledFetch(url: string, minGapMs = 1100): Promise<Response> {
  const elapsed = Date.now() - lastRequest
  if (elapsed < minGapMs) await sleep(minGapMs - elapsed)
  lastRequest = Date.now()
  return fetch(url, {
    headers: { 'User-Agent': 'PokeEdge/1.0', Accept: '*/*' },
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
    loosePriceDollars: typeof d['loose-price'] === 'number' ? (d['loose-price'] as number) / 100 : null,
    salesVolume: parseInt(String(d['sales-volume'] ?? '0'), 10) || 0,
  }
}

async function fetchPcMeta(token: string, pcId: string): Promise<{ consoleName: string; productName: string } | null> {
  const url = `${PC_BASE}/api/product?t=${token}&id=${pcId}`
  const resp = await throttledFetch(url)
  if (!resp.ok) return null
  const d = (await resp.json()) as Record<string, unknown>
  if (d.status !== 'success') return null
  return {
    consoleName: String(d['console-name'] ?? ''),
    productName: String(d['product-name'] ?? ''),
  }
}

/* ── Phase 2: Scrape VGPC.chart_data from product pages ────── */

type ChartPoints = [number, number][]

interface ChartData {
  used: ChartPoints
  newSealed: ChartPoints
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
    return {
      used: Array.isArray(raw.used) ? (raw.used as ChartPoints) : [],
      newSealed: Array.isArray(raw.new) ? (raw.new as ChartPoints) : [],
    }
  } catch {
    return null
  }
}

/* ── Phase 3: Store historical data ────────────────────────── */

function storeCardHistory(db: Database.Database, cardId: string, points: ChartPoints) {
  const stmt = db.prepare(
    `INSERT INTO price_history (card_id, timestamp, tcgplayer_market, tcgplayer_low, ebay_median, pricecharting_median)
     VALUES (@cid, @ts, @tcg, NULL, NULL, @pc)
     ON CONFLICT(card_id, timestamp) DO UPDATE SET
       pricecharting_median = excluded.pricecharting_median,
       tcgplayer_market = COALESCE(price_history.tcgplayer_market, excluded.tcgplayer_market)`,
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
}

export async function runPricechartingBackfill(db: Database.Database, opts: { force?: boolean } = {}): Promise<BackfillStats> {
  const token = config.pricechartingApiKey
  if (!token) {
    console.log('[pc-backfill] No PRICECHARTING_API_KEY configured, aborting')
    return { cardsMatched: 0, cardsScraped: 0, sealedScraped: 0, errors: 0 }
  }

  console.log('[pc-backfill] ═══════════════════════════════════════')
  console.log('[pc-backfill] PriceCharting Historical Backfill START')
  console.log('[pc-backfill] ═══════════════════════════════════════')

  const stats: BackfillStats = { cardsMatched: 0, cardsScraped: 0, sealedScraped: 0, errors: 0 }

  /* ── Phase 1: Match cards to PriceCharting product IDs ────── */
  const cards = db
    .prepare(
      `SELECT c.id, c.name, c.set_id, c.market_price, c.pricecharting_id, s.name AS set_name
       FROM cards c
       LEFT JOIN sets s ON c.set_id = s.id
       WHERE c.name IS NOT NULL
       ORDER BY COALESCE(c.market_price, 0) DESC`,
    )
    .all() as {
    id: string
    name: string
    set_id: string | null
    market_price: number | null
    pricecharting_id: string | null
    set_name: string | null
  }[]

  const updatePcStmt = db.prepare(`UPDATE cards SET pricecharting_id = ?, pricecharting_median = ? WHERE id = ?`)
  const pcMeta = new Map<string, { consoleName: string; productName: string }>()
  let alreadyMatched = 0

  console.log(`[pc-backfill] Phase 1: Matching ${cards.length} cards to PriceCharting...`)

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i]

    if (card.pricecharting_id) {
      alreadyMatched++
      continue
    }

    try {
      const num = extractNumber(card.id)
      const result = await matchCard(token, card.name, num, card.set_name)
      if (result) {
        updatePcStmt.run(result.pcId, result.loosePriceDollars, card.id)
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
    for (let i = 0; i < needsMeta.length; i++) {
      const card = needsMeta[i]
      try {
        const meta = await fetchPcMeta(token, card.pricecharting_id!)
        if (meta) pcMeta.set(card.id, meta)
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

  for (let i = 0; i < cardsWithMeta.length; i++) {
    const card = cardsWithMeta[i]
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

  /* ── Phase 4: Sealed product historical prices ────────────── */
  console.log(`[pc-backfill] Phase 4: Scraping sealed product history...`)

  const existingSealedCount = db.prepare(
    `SELECT COUNT(*) as c FROM sealed_products WHERE source = 'pricecharting-history'`,
  )

  for (const entry of SEALED_CATALOG) {
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

  console.log('[pc-backfill] ═══════════════════════════════════════')
  console.log(`[pc-backfill] COMPLETE — matched: ${stats.cardsMatched}, scraped: ${stats.cardsScraped}, sealed: ${stats.sealedScraped}, errors: ${stats.errors}`)
  console.log('[pc-backfill] ═══════════════════════════════════════')

  return stats
}
