import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import compression from 'compression'
import cookieParser from 'cookie-parser'
import rateLimit from 'express-rate-limit'
import type { Database } from 'better-sqlite3'
import { config } from './config.js'
import { cacheGet, cacheInvalidateAll, cacheSet, cachedJson } from './cache.js'
import { buildCardShowHtml } from './services/cardShowExport.js'
import { getEurPerUsd } from './services/fx.js'
import { predictChaseForUpcoming } from './services/upcoming.js'
import { getVapidPublicKey, notifyPriceAlerts, saveSubscription } from './services/push.js'
import { computePrintBuckets } from './services/printBuckets.js'
import { orderByClause, parseCardsListFilters } from './services/cardsListQuery.js'
import {
  aiDecision,
  buildComparableCards,
  buildNegotiation,
  buildThesis,
  computeAiScore,
  inferCatalystEvent,
  inferPokemonTier,
} from './services/investment.js'
import { refreshSealedPrices, storePriceSnapshot } from './services/sealedPrices.js'
import { computeTrackRecord, takePredictionSnapshot } from './services/trackRecord.js'
import { forecastTimeSeries } from './services/analytics/timeseries.js'
import { trainGradientBoostModel, predictGradientBoost } from './services/analytics/gradientBoost.js'
import { computeFeatureImportance } from './services/analytics/featureImportance.js'
import { detectMomentumCards, getCardMomentum } from './services/analytics/momentum.js'
import { analyzeCardSentiment, getTopSentiment } from './services/analytics/sentiment.js'
import { detectSupplyShocks } from './services/analytics/supplyShock.js'
import { detectAnomalies } from './services/analytics/anomaly.js'
import { findCointegrationPairs } from './services/analytics/cointegration.js'
import { bayesianEstimate } from './services/analytics/bayesian.js'
import { runClustering, getCardCluster } from './services/analytics/clustering.js'
import { computePCA } from './services/analytics/pca.js'
import {
  getModelRunTime, getRunProgress, isRunning, startRun,
  updateRunProgress, completeRunStep, finishRun,
} from './services/analytics/shared.js'
import { loadModelResult } from './modelStore.js'
import { authRoutes } from './routes/auth.js'
import { canaryRoutes } from './routes/canary.js'
import { stripeRoutes, stripeWebhookRoute } from './routes/stripe.js'
import { authenticate, optionalAuth, requireAdmin, requireRole, isFreeUser, freeSetFilter, getFreeSetIds } from './middleware/auth.js'
import { applyHistoryDisplayFilter } from './services/historyDisplayFilter.js'

/**
 * Express app with all `/api` routes. Pass a database instance (file or :memory: for tests).
 */
export function createApp(db: Database) {
  const app = express()
  app.set('trust proxy', 1)

  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }))
  app.use(compression())
  app.use(cors({
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }))
  // Refresh tokens live in an httpOnly cookie so a successful XSS can't
  // exfiltrate them (the access token is short-lived and stays in JS).
  // cookie-parser populates req.cookies for the /api/auth/refresh handler.
  app.use(cookieParser())

  // Global API limiter. 300/15min was way too tight for an SPA that fires
  // 20-40 parallel requests per page load (Cards tab alone: list + filters +
  // detail + history + buy-links + watchlist + ...). An active user could
  // hit 300 in 2-3 minutes, then be locked out of the whole app including
  // login retry. 2000/15min ≈ 130/min is still stricter than the per-route
  // limits that actually matter (auth), and more than enough for a human
  // plus React Strict Mode double-renders in dev.
  //
  // We also exempt the auth routes from this limiter entirely: they have
  // their own tighter limiter below, and we don't want a user who's been
  // browsing to be unable to sign out and back in.
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 2000,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) =>
      req.path === '/api/health' ||
      req.path.startsWith('/api/auth/') ||
      req.path.startsWith('/api/internal/'), // admin-only; JWT role-gated anyway
    message: { error: 'Too many requests — slow down and try again in a minute.' },
  })
  app.use('/api', apiLimiter)

  // Login/register have their own limiter so a bot spraying passwords
  // can't burn through the global budget. Two important properties:
  //
  //   1. `skipSuccessfulRequests: true` — a legit user signing in from
  //      multiple tabs / devices / after logout shouldn't burn their
  //      budget. Only FAILED attempts count. Without this, a user with
  //      5 tabs open and a session expiry can hit 429 just by everyone
  //      re-signing in, and the UI surfaces it as "Too many attempts"
  //      right after a successful password entry — indistinguishable
  //      from "wrong password" to a non-technical user.
  //   2. Raised max to 60 per 15 min. Brute-forcing a password at ≤1
  //      attempt per 15s is not a viable attack, and humans mistype.
  //
  // Default keyGenerator is per-IP (via `trust proxy: 1` above reading
  // Caddy's X-Forwarded-For, confirmed below) — so one abusive IP can't
  // eat the whole budget for other users.
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'Too many login attempts — please wait a few minutes.' },
  })
  app.use('/api/auth/login', authLimiter)
  app.use('/api/auth/register', authLimiter)
  app.use('/api/auth/google', authLimiter)

  app.use('/api/webhooks', express.raw({ type: 'application/json' }), stripeWebhookRoute(db))

  app.use(express.json({ limit: '1mb' }))
  app.use('/api/auth', authRoutes(db))
  app.use('/api/subscription', stripeRoutes(db))

  app.get('/api/health', (_req, res) => {
    const n = db.prepare(`SELECT COUNT(*) as c FROM cards`).get() as { c: number }
    res.json({ ok: true, cards: n.c })
  })

  app.use(canaryRoutes(db))

  app.post('/api/internal/refresh', authenticate, requireAdmin, async (_req, res) => {
    const { fullRefresh } = await import('./services/cron.js')
    try {
      await fullRefresh(db)
      cacheInvalidateAll()
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) })
    }
  })

  app.get('/api/dashboard', optionalAuth, (req, res) => {
    const cacheKey = 'GET:/api/dashboard'
    const hit = cacheGet(cacheKey)
    if (hit) {
      res.setHeader('Cache-Control', 'private, max-age=15')
      return res.type('json').send(hit)
    }
    const total = db.prepare(`SELECT COUNT(*) as c FROM cards`).get() as { c: number }
    const undervalued = db.prepare(`SELECT COUNT(*) as c FROM cards WHERE valuation_flag LIKE '%UNDERVALUED%'`).get() as {
      c: number
    }
    const reg = db.prepare(`SELECT r_squared FROM regression_state WHERE id = 1`).get() as
      | { r_squared: number }
      | undefined
    const portfolio = db
      .prepare(
        `SELECT COALESCE(SUM(c.market_price * w.quantity), 0) as v
         FROM watchlist w JOIN cards c ON c.id = w.card_id`,
      )
      .get() as { v: number }

    const body = {
      totalCards: total.c,
      undervaluedSignals: undervalued.c,
      avgModelAccuracy: reg?.r_squared ?? 0.88,
      portfolioValue: portfolio.v,
    }
    cacheSet(cacheKey, body, 25_000)
    res.setHeader('Cache-Control', 'private, max-age=15')
    res.json(body)
  })

  app.get('/api/track-record', (_req, res) => {
    const cacheKey = 'GET:/api/track-record'
    const hit = cacheGet(cacheKey)
    if (hit) {
      res.setHeader('Cache-Control', 'private, max-age=30')
      return res.type('json').send(hit)
    }
    const body = computeTrackRecord(db)
    cacheSet(cacheKey, body, 60_000)
    res.setHeader('Cache-Control', 'private, max-age=30')
    res.json(body)
  })

  app.post('/api/track-record/snapshot', (_req, res) => {
    takePredictionSnapshot(db)
    res.json({ ok: true })
  })

  app.get('/api/meta/card-filters', optionalAuth, (req, res) => {
    const setIdParam = ((req.query.set_id as string) || '').trim()
    const setId = setIdParam.length ? setIdParam : null
    const free = isFreeUser(req)
    const cacheKey = `GET:/api/meta/card-filters:set=${setId ?? ''}:tier=${free ? 'free' : 'full'}`
    const hit = cacheGet(cacheKey)
    if (hit) {
      res.setHeader('Cache-Control', 'private, max-age=30')
      return res.type('json').send(hit)
    }

    let setsQuery = `SELECT s.id, s.name, s.release_date, s.series, s.total_cards
         FROM sets s
         WHERE s.id IN (SELECT DISTINCT set_id FROM cards WHERE set_id IS NOT NULL)`
    const setsParams: string[] = []
    if (free) {
      const allowed = getFreeSetIds(db)
      setsQuery += ` AND s.id IN (${allowed.map(() => '?').join(', ')})`
      setsParams.push(...allowed)
    }
    setsQuery += ` ORDER BY CASE WHEN s.release_date IS NULL OR trim(s.release_date) = '' THEN 1 ELSE 0 END ASC,
           s.release_date DESC,
           s.name COLLATE NOCASE ASC`
    const setsWithMeta = db.prepare(setsQuery).all(...setsParams) as {
      id: string
      name: string | null
      release_date: string | null
      series: string | null
      total_cards: number | null
    }[]

    const printBuckets = computePrintBuckets(db, setId)

    const body = {
      sets: setsWithMeta,
      setIds: setsWithMeta.map((s) => s.id),
      printBuckets,
      tier_limited: free,
    }
    cacheSet(cacheKey, body, 45_000)
    res.setHeader('Cache-Control', 'private, max-age=30')
    res.json(body)
  })

  app.get('/api/cards', optionalAuth, (req, res) => {
    const cacheKey = `GET:${req.originalUrl}:tier=${isFreeUser(req) ? 'free' : 'full'}`
    const hit = cacheGet(cacheKey)
    if (hit) {
      res.setHeader('Cache-Control', 'private, max-age=10')
      return res.type('json').send(hit)
    }

    const f = parseCardsListFilters(req.query)
    const limitRaw = parseInt(String(req.query.limit ?? '100'), 10)
    const limit = Number.isFinite(limitRaw) ? Math.min(5000, Math.max(1, limitRaw)) : 100
    const offsetRaw = parseInt(String(req.query.offset ?? '0'), 10)
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0

    const tier = freeSetFilter(db, req)
    const tierSql = tier ? tier.sql : ''
    const tierParams = tier ? tier.ids : []

    const baseWhere = `FROM cards WHERE 1=1${f.whereSuffix}${tierSql}`
    const countRow = db.prepare(`SELECT COUNT(*) as c ${baseWhere}`).get(...f.params, ...tierParams) as { c: number }
    const total = countRow.c

    const slim = String(req.query.slim ?? '') === '1'
    const selectCols = slim
      ? `SELECT id, name, set_id, rarity, image_url, pull_cost_score, desirability_score,
         predicted_price, market_price, valuation_flag, reddit_buzz_score, trends_score,
         future_value_12m, annual_growth_rate`
      : 'SELECT *'
    const sql = `${selectCols} ${baseWhere}${orderByClause(f)} LIMIT ? OFFSET ?`
    const rows = db.prepare(sql).all(...f.params, ...tierParams, limit, offset) as {
      id: string
      name: string
      set_id: string | null
      rarity: string | null
      predicted_price: number | null
      market_price: number | null
      pull_cost_score: number | null
      desirability_score: number | null
      reddit_buzz_score: number | null
      trends_score: number | null
      future_value_12m: number | null
      annual_growth_rate: number | null
      [k: string]: unknown
    }[]
    const cardIds = rows.map((r) => r.id).filter(Boolean)
    const sparkByCard = slim ? null : getSparklineMap(db, cardIds)
    const enriched = rows.map((r) => {
      const score = computeAiScore({
        ...r,
        google_trends_score: r.trends_score,
      })
      return {
        ...r,
        ai_score: Number(score.toFixed(4)),
        ai_decision: aiDecision(score),
        ...(sparkByCard ? { spark_30d: sparkByCard.get(r.id) ?? [] } : {}),
      }
    })

    const body = {
      items: enriched,
      total,
      limit,
      offset,
      tier_limited: !!tier,
    }
    cacheSet(cacheKey, body, 15_000)
    res.setHeader('Cache-Control', 'private, max-age=10')
    res.json(body)
  })

  app.get('/api/cards/:id/buy-links', (req, res) => {
    const row = db.prepare(
      `SELECT c.id, c.name, c.set_id, s.name AS set_name
       FROM cards c LEFT JOIN sets s ON c.set_id = s.id
       WHERE c.id = ?`,
    ).get(String(req.params.id)) as
      | { id: string; name: string; set_id: string | null; set_name: string | null }
      | undefined
    if (!row) return res.status(404).json({ error: 'Not found' })
    const num = row.id.includes('-') ? row.id.slice(row.id.lastIndexOf('-') + 1) : ''
    const specific = [row.name, num, row.set_name].filter(Boolean).join(' ')
    const qSpecific = encodeURIComponent(`${specific} pokemon card`)
    const tcg = `https://www.tcgplayer.com/search/pokemon/product?q=${encodeURIComponent(`${row.name} ${num} ${row.set_name ?? ''}`.trim())}`
    const ebay = `https://www.ebay.com/sch/i.html?_nkw=${qSpecific}&LH_Sold=1&LH_Complete=1`
    const whatnot = `https://www.whatnot.com/search?q=${encodeURIComponent(`${specific} pokemon tcg`)}`
    res.json({ tcgplayer: tcg, ebay, whatnot })
  })

  app.get('/api/cards/:id', optionalAuth, (req, res) => {
    const row = db.prepare(`SELECT * FROM cards WHERE id = ?`).get(String(req.params.id)) as { set_id?: string | null } | undefined
    if (!row) return res.status(404).json({ error: 'Not found' })
    if (isFreeUser(req) && row.set_id) {
      const allowed = getFreeSetIds(db)
      if (!allowed.includes(row.set_id)) {
        return res.status(403).json({ error: 'Upgrade to premium to view cards from older sets' })
      }
    }
    const hist = db
      .prepare(
        `SELECT timestamp, COALESCE(pricecharting_median, tcgplayer_market) AS tcgplayer_market
         FROM price_history
         WHERE card_id = ?
           AND (pricecharting_median IS NOT NULL OR tcgplayer_market IS NOT NULL)
         ORDER BY timestamp DESC`,
      )
      .all(String(req.params.id))
    res.json({ card: row, priceHistory: hist })
  })

  // Per-grade history for the chart's Grade toggle.
  //
  //   /api/cards/:id/history?grade=raw                 — default; union of
  //      price_history.tcgplayer_market (live TCGPlayer ticks, outlier-gated)
  //      and card_grade_history raw series (PC chart). Same-day collisions
  //      prefer PC as the more stable number.
  //   /api/cards/:id/history?grade=raw&source=tcgplayer — TCGPlayer-only.
  //      Useful when the user wants to see the raw live-market series without
  //      any cross-source substitution.
  //   /api/cards/:id/history?grade=raw&source=pricecharting — PriceCharting-only.
  //   /api/cards/:id/history?grade=psa9|psa10|grade95    — reads directly from
  //      card_grade_history (always PC-sourced; source filter is a no-op
  //      here — tcgplayer returns [] since TCG has no graded series).
  //   /api/cards/:id/history?grade=bgs10                — only a point-in-time
  //      value exists (cards.pc_price_bgs10); response is a single row with
  //      `pointInTime: true` so the UI renders a dashed reference line
  //      rather than a series.
  //
  // Display sanity filter: after we assemble the series, if the card has a
  // PC anchor (pc_price_raw) we reject rows outside [anchor × 0.15, anchor ×
  // 3.0]. This is a purely read-side guard — the DB keeps everything, so
  // the next scrub pass can still see the bad rows. Without this, cards
  // like Pikachu VMAX that have continuous-block contamination not yet
  // cleaned by the scrub would show a rail of $3000 values next to their
  // true $5 value. The 0.15/3.0 band is loose enough to preserve legitimate
  // pumps/dips (a card tripling in a month is real) but tight enough to
  // kill the 100x-1000x contamination documented in the Apr 2026 audit.
  // If the filter would reject >60% of the series we bail out (anchor is
  // probably stale) and return the raw series so the user can see SOMETHING.
  app.get('/api/cards/:id/history', optionalAuth, (req, res) => {
    const cardId = String(req.params.id)
    const card = db
      .prepare(
        `SELECT id, set_id, pc_price_bgs10, pc_price_raw, market_price FROM cards WHERE id = ?`,
      )
      .get(cardId) as {
      id: string
      set_id: string | null
      pc_price_bgs10: number | null
      pc_price_raw: number | null
      market_price: number | null
    } | undefined
    if (!card) return res.status(404).json({ error: 'Not found' })

    // Display-filter anchor preference:
    //   1. pc_price_raw   — PriceCharting raw median, the most trusted.
    //   2. market_price   — current TCG live price (kept fresh by the
    //                        ingest gate — already gated for outliers so
    //                        it's always a plausible current number).
    //   3. null           — no filter applied.
    // We fall through to market_price when a card isn't PC-matched yet,
    // which is ~3,500 of 20,000 cards post-match-phase. Without this
    // fallback those cards keep showing the $0.01-to-$3000 tail of
    // contamination while the backfill slowly trickles through.
    const displayAnchor =
      card.pc_price_raw != null && card.pc_price_raw > 0
        ? card.pc_price_raw
        : card.market_price != null && card.market_price > 0
          ? card.market_price
          : null

    if (isFreeUser(req) && card.set_id) {
      const allowed = getFreeSetIds(db)
      if (!allowed.includes(card.set_id)) {
        return res.status(403).json({ error: 'Upgrade to premium to view cards from older sets' })
      }
    }

    const grade = (typeof req.query.grade === 'string' ? req.query.grade : 'raw').toLowerCase()
    const VALID_GRADES = ['raw', 'grade7', 'grade8', 'grade9', 'grade95', 'psa10', 'bgs10']
    if (!VALID_GRADES.includes(grade)) {
      return res.status(400).json({ error: `invalid grade; use one of ${VALID_GRADES.join(', ')}` })
    }

    const source = (typeof req.query.source === 'string' ? req.query.source : 'both').toLowerCase()
    const VALID_SOURCES = ['both', 'tcgplayer', 'pricecharting']
    if (!VALID_SOURCES.includes(source)) {
      return res.status(400).json({ error: `invalid source; use one of ${VALID_SOURCES.join(', ')}` })
    }

    if (grade === 'bgs10') {
      if (card.pc_price_bgs10 == null || source === 'tcgplayer') {
        return res.json({ grade, source, pointInTime: true, series: [] })
      }
      return res.json({
        grade,
        source,
        pointInTime: true,
        series: [{ timestamp: new Date().toISOString(), price: card.pc_price_bgs10, source: 'pricecharting' }],
      })
    }

    if (grade === 'raw') {
      // Three compositions depending on `source`:
      //  - 'both'           : prefer PC over TCG on same-day collisions.
      //  - 'tcgplayer'      : only rows whose authoritative value came from
      //                       price_history.tcgplayer_market. Post-scrub
      //                       rows tagged 'scrubbed-winsorized' still qualify
      //                       (they originated as TCG ticks).
      //  - 'pricecharting'  : union of price_history.pricecharting_median
      //                       rows + card_grade_history raw series, with
      //                       PC preferred on collision (card_grade_history
      //                       tends to be denser/longer-running).
      let sql: string
      const params: any[] = []

      if (source === 'tcgplayer') {
        // Dedup to per-day (same shape as the other branches) — keep the
        // latest tick of each day as the canonical value. Without this the
        // chart would jitter to 5-7x density when the user flipped from
        // All → TCGPlayer, which is a confusing UX.
        sql = `
          WITH per_day AS (
            SELECT substr(timestamp, 1, 10) AS ts,
                   tcgplayer_market AS price,
                   ROW_NUMBER() OVER (PARTITION BY substr(timestamp, 1, 10) ORDER BY timestamp DESC) AS rn
            FROM price_history
            WHERE card_id = ?
              AND tcgplayer_market IS NOT NULL
              AND tcgplayer_market > 0
              AND (source IS NULL OR source NOT IN ('pricecharting-chart'))
          )
          SELECT ts AS timestamp, price, 'tcgplayer' AS source
          FROM per_day WHERE rn = 1
          ORDER BY ts ASC`
        params.push(cardId)
      } else if (source === 'pricecharting') {
        sql = `
          WITH pc_rows AS (
            SELECT substr(timestamp, 1, 10) AS ts,
                   pricecharting_median AS price,
                   'pricecharting' AS source,
                   1 AS prio
            FROM price_history
            WHERE card_id = ?
              AND pricecharting_median IS NOT NULL
              AND pricecharting_median > 0
            UNION ALL
            SELECT substr(ts, 1, 10) AS ts,
                   price,
                   'pricecharting-grade' AS source,
                   0 AS prio
            FROM card_grade_history
            WHERE card_id = ? AND grade = 'raw' AND price > 0
          ),
          ranked AS (
            SELECT ts, price, source,
                   ROW_NUMBER() OVER (PARTITION BY ts ORDER BY prio) AS rn
            FROM pc_rows
          )
          SELECT ts AS timestamp, price, source
          FROM ranked WHERE rn = 1
          ORDER BY ts ASC`
        params.push(cardId, cardId)
      } else {
        sql = `
          WITH unioned AS (
            SELECT substr(timestamp, 1, 10) AS ts,
                   COALESCE(pricecharting_median, tcgplayer_market) AS price,
                   CASE WHEN pricecharting_median IS NOT NULL THEN 'pricecharting' ELSE 'tcgplayer' END AS source,
                   CASE WHEN pricecharting_median IS NOT NULL THEN 0 ELSE 1 END AS prio
            FROM price_history
            WHERE card_id = ?
              AND COALESCE(pricecharting_median, tcgplayer_market) IS NOT NULL
              AND COALESCE(pricecharting_median, tcgplayer_market) > 0
            UNION ALL
            SELECT substr(ts, 1, 10) AS ts, price, 'pricecharting-grade' AS source, 0 AS prio
            FROM card_grade_history
            WHERE card_id = ? AND grade = 'raw' AND price > 0
          ),
          ranked AS (
            SELECT ts, price, source,
                   ROW_NUMBER() OVER (PARTITION BY ts ORDER BY prio) AS rn
            FROM unioned
          )
          SELECT ts AS timestamp, price, source
          FROM ranked WHERE rn = 1
          ORDER BY ts ASC`
        params.push(cardId, cardId)
      }

      const rawRows = db.prepare(sql).all(...params) as {
        timestamp: string
        price: number
        source: string
      }[]
      const { series: clean, filtered } = applyHistoryDisplayFilter(rawRows, displayAnchor)
      return res.json({ grade, source, pointInTime: false, series: clean, filtered })
    }

    // Graded series live only in card_grade_history (PC-sourced). `source`
    // filter is effectively a noop here — tcgplayer returns [] because we
    // don't have graded TCG data, and pricecharting/both return the series.
    if (source === 'tcgplayer') {
      return res.json({ grade, source, pointInTime: false, series: [] })
    }
    const rows = db
      .prepare(
        `SELECT ts AS timestamp, price, source FROM card_grade_history
         WHERE card_id = ? AND grade = ? AND price > 0
         ORDER BY ts ASC`,
      )
      .all(cardId, grade) as { timestamp: string; price: number; source: string }[]
    // Graded series get the same display-filter, keyed off the matching
    // card-level PC anchor when one exists (e.g. psa10 → pc_price_psa10).
    const gradeAnchorMap: Record<string, keyof typeof card | null> = {
      grade7: null, grade8: null, grade9: null, grade95: null, psa10: null,
    }
    // intentionally use pc_price_<grade> when present on the card row
    const anchorRow = db
      .prepare(
        `SELECT pc_price_grade7, pc_price_grade8, pc_price_grade9,
                pc_price_grade95, pc_price_psa10 FROM cards WHERE id = ?`,
      )
      .get(cardId) as Record<string, number | null> | undefined
    const anchor =
      grade === 'psa10' ? anchorRow?.pc_price_psa10 ?? null :
      grade === 'grade95' ? anchorRow?.pc_price_grade95 ?? null :
      grade === 'grade9' ? anchorRow?.pc_price_grade9 ?? null :
      grade === 'grade8' ? anchorRow?.pc_price_grade8 ?? null :
      grade === 'grade7' ? anchorRow?.pc_price_grade7 ?? null :
      null
    void gradeAnchorMap
    const { series: clean, filtered } = applyHistoryDisplayFilter(rows, anchor ?? null)
    res.json({ grade, source, pointInTime: false, series: clean, filtered })
  })

  app.get('/api/cards/:id/investment', authenticate, requireRole('premium', 'admin'), (req, res) => {
    const row = db
      .prepare(
        `SELECT c.*, cp.google_trends_score
         FROM cards c
         LEFT JOIN character_premiums cp ON cp.character_name = c.character_name
         WHERE c.id = ?`,
      )
      .get(String(req.params.id)) as
      | {
          id: string
          name: string
          set_id: string | null
          rarity: string | null
          predicted_price: number | null
          market_price: number | null
          pull_cost_score: number | null
          desirability_score: number | null
          reddit_buzz_score: number | null
          google_trends_score: number | null
          future_value_12m: number | null
          annual_growth_rate: number | null
        }
      | undefined
    if (!row) return res.status(404).json({ error: 'Not found' })

    const score = computeAiScore(row)
    const decision = aiDecision(score)
    const fair = row.predicted_price ?? row.market_price ?? 0
    const redditNorm = Math.max(0, Math.min(1, (row.reddit_buzz_score ?? 0) / 20))
    const trendsNorm = Math.max(0, Math.min(1, (row.google_trends_score ?? 5) / 10))
    const momentum = redditNorm > 0.05 ? redditNorm * 0.6 + trendsNorm * 0.4 : trendsNorm * 0.7
    const popScarcity = Math.max(0, Math.min(1, (row.pull_cost_score ?? 5) / 10))
    const sentiment = Math.max(0, Math.min(1, (momentum + Math.max(0, Math.min(1, (row.desirability_score ?? 5) / 10))) / 2))
    const lifecycle = row.set_id ? 0.55 : 0.45
    const catalyst = inferCatalystEvent(row)
    const negotiation = buildNegotiation(fair, sentiment - 0.5, row.market_price)
    const comparable = buildComparableCards(db, row)

    res.json({
      card_name: row.name,
      set: row.set_id ?? 'unknown',
      grade: 'raw',
      composite_score: Number(score.toFixed(4)),
      signal_breakdown: {
        momentum: Number(momentum.toFixed(3)),
        pop_scarcity: Number(popScarcity.toFixed(3)),
        sentiment: Number(sentiment.toFixed(3)),
        lifecycle: Number(lifecycle.toFixed(3)),
      },
      pokemon_tier: inferPokemonTier(row.name),
      reprint_risk: fair > 80 ? 'low' : fair > 30 ? 'medium' : 'high',
      decision,
      investment_horizon: decision === 'BUY' ? 'medium' : decision === 'WATCH' ? 'short' : 'long',
      fair_value_estimate: Number(fair.toFixed(2)),
      negotiation,
      thesis: buildThesis(row, score),
      red_flags: buildRedFlags(row),
      catalyst_events: catalyst ? [catalyst] : [],
      comparable_cards: comparable,
    })
  })

  app.get('/api/signals', optionalAuth, (req, res) => {
    const sortParam = ((req.query.sort as string) || 'dollar').toLowerCase()
    const setIdFilter = ((req.query.set_id as string) || '').trim()
    const sortKeys: Record<string, string> = {
      dollar: `(predicted_price - COALESCE(market_price, 0)) DESC`,
      discount: `CASE
        WHEN predicted_price IS NOT NULL AND predicted_price > 0 AND market_price IS NOT NULL
        THEN (predicted_price - market_price) / predicted_price
        ELSE 0 END DESC`,
      market: `(market_price IS NULL), market_price ASC`,
      fair: `(predicted_price IS NULL), predicted_price DESC`,
      name: `name COLLATE NOCASE ASC`,
      set: `(set_id IS NULL), set_id COLLATE NOCASE ASC, name COLLATE NOCASE ASC`,
    }
    const orderBy = sortKeys[sortParam] ?? sortKeys.dollar
    const whereSet = setIdFilter ? ` AND set_id = ?` : ''
    const tier = freeSetFilter(db, req)
    const tierSql = tier ? tier.sql : ''
    const params: string[] = [...(setIdFilter ? [setIdFilter] : []), ...(tier ? tier.ids : [])]
    const rows = db
      .prepare(
        `SELECT * FROM cards WHERE (valuation_flag LIKE '%UNDERVALUED%' OR valuation_flag LIKE '%GROWTH%')${whereSet}${tierSql}
         ORDER BY ${orderBy} LIMIT 200`,
      )
      .all(...params)
    res.json(rows)
  })

  app.get('/api/alerts', optionalAuth, (req, res) => {
    const tier = freeSetFilter(db, req)
    const tierSql = tier ? ` AND c.set_id IN (${tier.ids.map(() => '?').join(', ')})` : ''
    const tierParams = tier ? tier.ids : []
    const rows = db
      .prepare(
        `SELECT c.*, w.target_buy_price, w.alert_active
         FROM cards c
         LEFT JOIN watchlist w ON w.card_id = c.id
         WHERE c.market_price IS NOT NULL${tierSql}
         ORDER BY c.last_updated DESC
         LIMIT 500`,
      )
      .all(...tierParams) as Array<
      {
        id: string
        name: string
        set_id: string | null
        rarity: string | null
        predicted_price: number | null
        market_price: number | null
        pull_cost_score: number | null
        desirability_score: number | null
        reddit_buzz_score: number | null
        trends_score: number | null
        target_buy_price: number | null
        alert_active: number | null
      } & Record<string, unknown>
    >
    const out = rows
      .map((r) => {
        const score = computeAiScore({ ...r, google_trends_score: r.trends_score })
        const decision = aiDecision(score)
        const clean = !isAnomalyRisky(db, r.id)
        return {
          ...r,
          ai_score: Number(score.toFixed(4)),
          ai_decision: decision,
          anomaly_flag: clean ? 1 : -1,
        }
      })
      .filter((r) => r.ai_decision === 'BUY' && r.anomaly_flag === 1)
      .sort((a, b) => b.ai_score - a.ai_score)
      .slice(0, 200)
    res.json(out)
  })

  app.get('/api/sets', optionalAuth, (req, res) => {
    const free = isFreeUser(req)
    const cacheKey = `GET:/api/sets:tier=${free ? 'free' : 'full'}`
    const hit = cacheGet(cacheKey)
    if (hit) {
      res.setHeader('Cache-Control', 'private, max-age=30')
      return res.type('json').send(hit)
    }
    let rows
    if (free) {
      const ids = getFreeSetIds(db)
      const ph = ids.map(() => '?').join(', ')
      rows = db.prepare(`SELECT * FROM sets WHERE id IN (${ph}) ORDER BY release_date DESC`).all(...ids)
    } else {
      rows = db.prepare(`SELECT * FROM sets ORDER BY release_date DESC`).all()
    }
    cacheSet(cacheKey, rows, 60_000)
    res.setHeader('Cache-Control', 'private, max-age=30')
    res.json(rows)
  })

  app.get('/api/reddit/pulse', (_req, res) => {
    const cacheKey = 'GET:/api/reddit/pulse'
    const hit = cacheGet(cacheKey)
    if (hit) {
      res.setHeader('Cache-Control', 'private, max-age=20')
      return res.type('json').send(hit)
    }
    const rows = db
      .prepare(
        `SELECT id, name, reddit_buzz_score, market_price FROM cards WHERE reddit_buzz_score > 0 ORDER BY reddit_buzz_score DESC LIMIT 50`,
      )
      .all()
    cacheSet(cacheKey, rows, 35_000)
    res.setHeader('Cache-Control', 'private, max-age=20')
    res.json(rows)
  })

  app.get('/api/upcoming', (_req, res) => {
    const cacheKey = 'GET:/api/upcoming'
    const hit = cacheGet(cacheKey)
    if (hit) {
      res.setHeader('Cache-Control', 'private, max-age=45')
      return res.type('json').send(hit)
    }
    const rows = db.prepare(`SELECT * FROM upcoming_sets ORDER BY release_date ASC`).all()
    cacheSet(cacheKey, rows, 60_000)
    res.setHeader('Cache-Control', 'private, max-age=45')
    res.json(rows)
  })

  app.get('/api/upcoming/:id/predict', (req, res) => {
    try {
      predictChaseForUpcoming(db, String(req.params.id))
      const row = db.prepare(`SELECT * FROM upcoming_sets WHERE id = ?`).get(String(req.params.id))
      res.json(row)
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  app.get('/api/watchlist', (_req, res) => {
    const rows = db
      .prepare(
        `SELECT w.*, c.name, c.image_url, c.market_price FROM watchlist w LEFT JOIN cards c ON c.id = w.card_id ORDER BY w.id DESC`,
      )
      .all()
    res.json(rows)
  })

  app.post('/api/watchlist', (req, res) => {
    const b = req.body as {
      card_id: string
      quantity?: number
      condition?: string
      purchase_price?: number
      purchase_date?: string
      target_buy_price?: number
      alert_active?: number
    }
    db.prepare(
      `INSERT INTO watchlist (card_id, quantity, condition, purchase_price, purchase_date, target_buy_price, alert_active)
       VALUES (@card_id, @quantity, @condition, @purchase_price, @purchase_date, @target_buy_price, @alert_active)`,
    ).run({
      card_id: b.card_id,
      quantity: b.quantity ?? 1,
      condition: b.condition ?? 'NM',
      purchase_price: b.purchase_price ?? null,
      purchase_date: b.purchase_date ?? null,
      target_buy_price: b.target_buy_price ?? null,
      alert_active: b.alert_active ?? 0,
    })
    res.json({ ok: true })
  })

  app.delete('/api/watchlist/:id', (req, res) => {
    db.prepare(`DELETE FROM watchlist WHERE id = ?`).run(String(req.params.id))
    res.json({ ok: true })
  })

  app.get('/api/arbitrage', async (_req, res) => {
    const eur = await getEurPerUsd(db)
    const rows = db
      .prepare(
        `SELECT id, name, market_price, ebay_median, cardmarket_eur FROM cards
         WHERE market_price IS NOT NULL LIMIT 300`,
      )
      .all() as {
      id: string
      name: string
      market_price: number
      ebay_median: number | null
      cardmarket_eur: number | null
    }[]

    const tcgFee = 0.1025
    const ebayFee = 0.13
    const out = []
    for (const r of rows) {
      if (r.ebay_median && r.market_price) {
        const spread = (r.ebay_median * (1 - ebayFee) - r.market_price * (1 + tcgFee)) / r.market_price
        if (spread > 0.15)
          out.push({
            id: r.id,
            name: r.name,
            type: 'TCGPlayer vs eBay',
            spreadPct: Math.round(spread * 100),
          })
      }
      if (r.cardmarket_eur && r.market_price) {
        const cmUsd = r.cardmarket_eur / eur
        const spread = Math.abs(cmUsd - r.market_price) / r.market_price
        if (spread > 0.15)
          out.push({
            id: r.id,
            name: r.name,
            type: 'USD vs CardMarket (EUR)',
            spreadPct: Math.round(spread * 100),
          })
      }
    }
    res.json(out.slice(0, 100))
  })

  app.get('/api/push/vapid-public', (_req, res) => {
    res.json({ publicKey: getVapidPublicKey() })
  })

  app.post('/api/push/subscribe', (req, res) => {
    try {
      saveSubscription(db, req.body)
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e) })
    }
  })

  app.post('/api/push/test', async (_req, res) => {
    await notifyPriceAlerts(db)
    res.json({ ok: true })
  })

  app.get('/api/export/card-show', async (_req, res) => {
    const html = await buildCardShowHtml(db)
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(html)
  })

  app.patch('/api/cards/:id/artwork-score', (req, res) => {
    const v = Number((req.body as { score?: number }).score)
    if (Number.isNaN(v)) return res.status(400).json({ error: 'score required' })
    db.prepare(`UPDATE cards SET artwork_hype_score = ? WHERE id = ?`).run(Math.min(10, Math.max(1, v)), String(req.params.id))
    res.json({ ok: true })
  })

  /* ── Sealed product prices ─────────────────────────────────── */

  app.get('/api/sealed-prices/:setId', (req, res) => {
    const rows = db
      .prepare(
        `SELECT set_id, product_type, source, price, packs, fetched_at
         FROM sealed_products WHERE set_id = ? ORDER BY fetched_at DESC`,
      )
      .all(String(req.params.setId))
    res.json(rows)
  })

  app.post('/api/sealed-prices', (req, res) => {
    const b = req.body as {
      set_id: string
      product_type: string
      source?: string
      price: number
      packs: number
    }
    if (!b.set_id || !b.product_type || !b.price || b.price <= 0) {
      return res.status(400).json({ error: 'set_id, product_type, and positive price required' })
    }
    storePriceSnapshot(
      db,
      b.set_id,
      b.product_type as 'bb' | 'etb',
      b.source ?? 'manual',
      b.price,
      b.packs ?? 36,
    )
    cacheInvalidateAll()
    res.json({ ok: true })
  })

  // POST /api/internal/backfill-pricecharting          — full catalog (6+ hrs)
  //     ?force=1                                       — re-scrape even if already have history
  //     ?cardId=sv4pt5-232                             — one card; skips sealed (fast, ~5s)
  //     ?setId=sv4pt5                                  — one set
  //     ?limit=500                                     — top-N by market_price
  //     ?skipSealed=1                                  — skip Phase 4 on full run
  app.post('/api/internal/backfill-pricecharting', authenticate, requireAdmin, async (req, res) => {
    const { runPricechartingBackfill, isBackfillRunning } = await import('./services/pricechartingBackfill.js')
    if (isBackfillRunning()) {
      res.status(409).json({
        ok: false,
        error: 'A backfill is already running on this node. Wait for it to finish or check status.',
      })
      return
    }
    const opts: {
      force?: boolean
      cardId?: string
      setId?: string
      limit?: number
      skipSealed?: boolean
    } = {
      force: req.query.force === '1' || req.query.force === 'true',
      skipSealed: req.query.skipSealed === '1' || req.query.skipSealed === 'true',
    }
    if (typeof req.query.cardId === 'string' && req.query.cardId) opts.cardId = req.query.cardId
    if (typeof req.query.setId === 'string' && req.query.setId) opts.setId = req.query.setId
    if (typeof req.query.limit === 'string') {
      const n = parseInt(req.query.limit, 10)
      if (Number.isFinite(n) && n > 0) opts.limit = n
    }
    res.json({
      ok: true,
      message: `Backfill started in background — watch server console or /api/internal/backfill-pricecharting/status`,
      opts,
    })
    try {
      const stats = await runPricechartingBackfill(db, opts)
      console.log('[backfill] Finished:', stats)
    } catch (e) {
      console.error('[backfill] Failed:', e)
    }
  })

  // Read-only status of the backfill — durable counts from the DB plus
  // in-memory progress from any currently-running job on this node. The
  // admin dashboard polls this every ~10s to show a progress bar without
  // touching the orchestrator itself.
  app.get(
    '/api/internal/backfill-pricecharting/status',
    authenticate,
    requireAdmin,
    async (_req, res) => {
      try {
        const { getBackfillStatus } = await import('./services/pricechartingBackfill.js')
        const status = getBackfillStatus(db)
        res.json({ ok: true, status })
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e) })
      }
    },
  )

  app.post('/api/internal/refresh-sealed', authenticate, requireAdmin, async (_req, res) => {
    try {
      const result = await refreshSealedPrices(db)
      const { refreshSetMetrics } = await import('./services/setMetrics.js')
      refreshSetMetrics(db)
      cacheInvalidateAll()
      res.json({ ok: true, ...result })
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) })
    }
  })

  // Admin-triggered price-history scrub. Uses the multi-signal algorithm in
  // priceHistoryScrub.ts. Safe to re-run (winsorized rows are marked and
  // skipped); `cardId` query param narrows to a single card for debugging.
  app.post('/api/internal/scrub-price-history', authenticate, requireAdmin, async (req, res) => {
    try {
      const { scrubPriceHistory } = await import('./services/priceHistoryScrub.js')
      const cardId = typeof req.query.cardId === 'string' ? req.query.cardId : undefined
      const verbose = req.query.verbose === '1' || req.query.verbose === 'true'
      const result = scrubPriceHistory(db, { cardId, verbose })
      cacheInvalidateAll()
      res.json({ ok: true, ...result })
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) })
    }
  })

  // Catalog-wide price-history audit. See services/priceHistoryAudit.ts
  // for the full rationale. Mirrors the display filter's anchor + band
  // logic so the numbers it reports match what a real user would see on
  // the card chart. Read-only by default; pass `fix=1` to auto-scrub
  // every offender in one pass (serial, not parallel — the scrub holds
  // SQLite write locks). Pagination is via `threshold` and `limit` —
  // only `offenders` is capped, the summary counts are always complete.
  app.get('/api/internal/price-history-audit', authenticate, requireAdmin, async (req, res) => {
    try {
      const { auditPriceHistory } = await import('./services/priceHistoryAudit.js')
      const threshold = Number(req.query.threshold) || undefined
      const limit = Number(req.query.limit) || undefined
      const cardId = typeof req.query.cardId === 'string' ? req.query.cardId : undefined
      const fix = req.query.fix === '1' || req.query.fix === 'true'
      const result = auditPriceHistory(db, {
        thresholdRatio: threshold,
        maxOffenders: limit,
        cardId,
      })
      if (!fix || result.offenders.length === 0) {
        return res.json({ ok: true, ...result, fixed: null })
      }
      const { scrubPriceHistory } = await import('./services/priceHistoryScrub.js')
      let deleted = 0
      let winsorized = 0
      let modified = 0
      for (const o of result.offenders) {
        const s = scrubPriceHistory(db, { cardId: o.card_id })
        deleted += s.rowsDeleted
        winsorized += s.rowsWinsorized
        if (s.rowsDeleted + s.rowsWinsorized > 0) modified++
      }
      cacheInvalidateAll()
      const after = auditPriceHistory(db, {
        thresholdRatio: threshold,
        maxOffenders: 0,
        cardId,
      })
      res.json({
        ok: true,
        ...result,
        fixed: {
          cards_modified: modified,
          rows_deleted: deleted,
          rows_winsorized: winsorized,
          offenders_remaining: after.summary.offenders,
        },
      })
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) })
    }
  })

  /* ── Analytics model endpoints (all require premium) ──────── */

  const premiumAuth = [authenticate, requireRole('premium', 'admin')] as const

  app.get('/api/models/timeseries/:cardId', ...premiumAuth, (req, res) => {
    const horizon = Math.min(180, Math.max(7, parseInt(String(req.query.horizon ?? '30'), 10) || 30))
    const result = forecastTimeSeries(db, String(req.params.cardId), horizon)
    res.json(result)
  })

  app.post('/api/models/gradient-boost/train', authenticate, requireAdmin, (_req, res) => {
    try {
      const model = trainGradientBoostModel(db)
      res.json({ ok: true, trained_at: model.trainedAt, features: model.featureLabels.length })
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) })
    }
  })

  app.get('/api/models/gradient-boost/predict/:cardId', ...premiumAuth, (req, res) => {
    res.json(predictGradientBoost(db, String(req.params.cardId)))
  })

  app.get('/api/models/random-forest/feature-importance', ...premiumAuth, cachedJson(1_800_000, () => {
    return loadModelResult(db, 'feature-importance') ?? computeFeatureImportance(db)
  }))

  app.get('/api/models/momentum/cards', ...premiumAuth, cachedJson(1_800_000, (req) => {
    const stored = loadModelResult(db, 'momentum') as { items: unknown[]; total: number } | null
    const all = stored ? stored.items : detectMomentumCards(db)
    const limit = clampInt(req.query.limit, 1, 100, 15)
    const offset = clampInt(req.query.offset, 0, (all as unknown[]).length, 0)
    return { items: (all as unknown[]).slice(offset, offset + limit), total: (all as unknown[]).length }
  }))

  app.get('/api/models/momentum/:cardId', ...premiumAuth, (req, res) => {
    res.json(getCardMomentum(db, String(req.params.cardId)))
  })

  app.get('/api/models/sentiment/top-positive', ...premiumAuth, cachedJson(1_800_000, () => {
    return loadModelResult(db, 'sentiment-positive') ?? getTopSentiment(db, 'positive')
  }))
  app.get('/api/models/sentiment/top-negative', ...premiumAuth, cachedJson(1_800_000, () => {
    return loadModelResult(db, 'sentiment-negative') ?? getTopSentiment(db, 'negative')
  }))

  app.get('/api/models/sentiment/:cardId', ...premiumAuth, (req, res) => {
    res.json(analyzeCardSentiment(db, String(req.params.cardId)))
  })

  app.get('/api/models/supply-shock/alerts', ...premiumAuth, cachedJson(1_800_000, (req) => {
    const stored = loadModelResult(db, 'supply-shock') as { items: unknown[]; total: number } | null
    const all = stored ? stored.items : detectSupplyShocks(db)
    const limit = clampInt(req.query.limit, 1, 100, 30)
    const offset = clampInt(req.query.offset, 0, (all as unknown[]).length, 0)
    return { items: (all as unknown[]).slice(offset, offset + limit), total: (all as unknown[]).length }
  }))

  app.get('/api/models/anomalies/recent', ...premiumAuth, cachedJson(1_800_000, (req) => {
    const stored = loadModelResult(db, 'anomaly') as { items: unknown[]; total: number } | null
    const all = stored ? stored.items : detectAnomalies(db, { days: 30 })
    const limit = clampInt(req.query.limit, 1, 100, 30)
    const offset = clampInt(req.query.offset, 0, (all as unknown[]).length, 0)
    return { items: (all as unknown[]).slice(offset, offset + limit), total: (all as unknown[]).length }
  }))

  app.get('/api/models/anomalies/:cardId', ...premiumAuth, (req, res) => {
    res.json(detectAnomalies(db, { cardId: String(req.params.cardId) }))
  })

  app.get('/api/models/cointegration/pairs', ...premiumAuth, cachedJson(1_800_000, (req) => {
    const stored = loadModelResult(db, 'cointegration') as { items: unknown[]; total: number } | null
    const all = stored ? stored.items : findCointegrationPairs(db)
    const limit = clampInt(req.query.limit, 1, 100, 20)
    const offset = clampInt(req.query.offset, 0, (all as unknown[]).length, 0)
    return { items: (all as unknown[]).slice(offset, offset + limit), total: (all as unknown[]).length }
  }))

  app.get('/api/models/cointegration/:cardId', ...premiumAuth, (req, res) => {
    res.json(findCointegrationPairs(db, { cardId: String(req.params.cardId), limit: 10 }))
  })

  app.get('/api/models/bayesian/estimate/:cardId', ...premiumAuth, (req, res) => {
    res.json(bayesianEstimate(db, String(req.params.cardId)))
  })

  app.get('/api/models/clusters/all', ...premiumAuth, cachedJson(1_800_000, () => {
    const stored = loadModelResult(db, 'clustering') as { profiles: unknown[] } | null
    if (stored) return stored
    const { profiles } = runClustering(db)
    return { profiles }
  }))

  app.get('/api/models/clusters/:cardId', ...premiumAuth, (req, res) => {
    res.json(getCardCluster(db, String(req.params.cardId)))
  })

  app.get('/api/models/pca/components', ...premiumAuth, cachedJson(1_800_000, () => {
    return loadModelResult(db, 'pca') ?? computePCA(db)
  }))

  app.get('/api/models/status', ...premiumAuth, (_req, res) => {
    const cacheKey = 'GET:/api/models/status'
    const hit = cacheGet(cacheKey)
    const cached = hit ? JSON.parse(hit) as { total: number; withHistory: number; with30pts: number } : null

    const total = cached?.total ?? (db.prepare(`SELECT COUNT(*) as c FROM cards WHERE market_price > 0`).get() as { c: number }).c
    const withHistory = cached?.withHistory ?? (db.prepare(
      `SELECT COUNT(DISTINCT ph.card_id) as c FROM price_history ph JOIN cards c ON c.id = ph.card_id WHERE c.market_price > 0`,
    ).get() as { c: number }).c
    const with30pts = cached?.with30pts ?? (db.prepare(
      `SELECT COUNT(*) as c FROM (
        SELECT ph.card_id FROM price_history ph
        JOIN cards c ON c.id = ph.card_id
        WHERE c.market_price > 0
        GROUP BY ph.card_id HAVING COUNT(DISTINCT substr(ph.timestamp, 1, 10)) >= 30
      )`,
    ).get() as { c: number }).c

    if (!cached) cacheSet(cacheKey, { total, withHistory, with30pts }, 60_000)

    const models = [
      { name: 'Time-Series Forecast', model_id: 'timeseries', min_data: 10, coverage: withHistory },
      { name: 'Gradient Boost Predictor', model_id: 'gradient-boost', min_data: 10, coverage: total },
      { name: 'Feature Importance (RF)', model_id: 'random-forest', min_data: 10, coverage: total },
      { name: 'Momentum Detector', model_id: 'lstm-momentum', min_data: 10, coverage: withHistory },
      { name: 'Sentiment Analysis', model_id: 'sentiment', min_data: 1, coverage: total },
      { name: 'Supply Shock Detector', model_id: 'supply-shock', min_data: 10, coverage: withHistory },
      { name: 'Anomaly Detector', model_id: 'anomaly', min_data: 10, coverage: withHistory },
      { name: 'Cointegration Analyzer', model_id: 'cointegration', min_data: 20, coverage: with30pts },
      { name: 'Bayesian Estimator', model_id: 'bayesian', min_data: 1, coverage: total },
      { name: 'Card Clustering', model_id: 'clustering', min_data: 10, coverage: total },
      { name: 'PCA Decomposer', model_id: 'pca', min_data: 10, coverage: total },
    ]

    res.json(models.map(m => ({
      name: m.name,
      model_id: m.model_id,
      last_run: getModelRunTime(m.model_id),
      card_coverage: m.coverage,
      total_cards: total,
      status: m.coverage >= m.min_data
        ? (getModelRunTime(m.model_id) ? 'ready' : 'not_run')
        : 'insufficient_data',
    })))
  })

  app.get('/api/models/progress', ...premiumAuth, (_req, res) => {
    res.json(getRunProgress())
  })

  const MODEL_RUNNERS: Record<string, () => void> = {
    'gradient-boost': () => trainGradientBoostModel(db),
    'random-forest': () => computeFeatureImportance(db),
    clustering: () => runClustering(db),
    pca: () => computePCA(db),
    'lstm-momentum': () => { detectMomentumCards(db) },
    'supply-shock': () => { detectSupplyShocks(db) },
    anomaly: () => { detectAnomalies(db, { days: 30 }) },
    cointegration: () => { findCointegrationPairs(db) },
  }

  app.post('/api/models/run/:modelId', authenticate, requireAdmin, (req, res) => {
    const modelId = String(req.params.modelId)
    const runner = MODEL_RUNNERS[modelId]
    if (!runner) return res.status(404).json({ ok: false, error: `Unknown model: ${modelId}` })

    if (!startRun(1, [modelId])) return res.status(409).json({ ok: false, error: 'Another run is in progress' })
    updateRunProgress(modelId)

    setImmediate(() => {
      try {
        runner()
        completeRunStep(modelId)
        cacheInvalidateAll()
      } catch (e) {
        finishRun(String(e))
        return
      }
      finishRun()
    })

    res.json({ ok: true, model_id: modelId })
  })

  app.post('/api/models/run-all', authenticate, requireAdmin, (_req, res) => {
    const modelIds = Object.keys(MODEL_RUNNERS)
    if (!startRun(modelIds.length, modelIds)) {
      return res.status(409).json({ ok: false, error: 'A run is already in progress' })
    }

    res.json({ ok: true, started_at: new Date().toISOString() })

    let idx = 0

    function runNext() {
      if (idx >= modelIds.length) {
        cacheInvalidateAll()
        finishRun()
        return
      }
      const modelId = modelIds[idx++]
      updateRunProgress(modelId)
      setImmediate(() => {
        try {
          MODEL_RUNNERS[modelId]()
          completeRunStep(modelId)
        } catch (e) {
          finishRun(String(e))
          return
        }
        runNext()
      })
    }

    setImmediate(runNext)
  })

  return app
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = parseInt(String(raw ?? ''), 10)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

function getSparklineMap(db: Database, cardIds: string[]): Map<string, { p: number }[]> {
  const byCard = new Map<string, { p: number }[]>()
  if (!cardIds.length) return byCard
  const placeholders = cardIds.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT card_id, timestamp, COALESCE(pricecharting_median, tcgplayer_market) AS price
       FROM price_history
       WHERE card_id IN (${placeholders})
         AND (pricecharting_median IS NOT NULL OR tcgplayer_market IS NOT NULL)
       ORDER BY card_id ASC, timestamp DESC`,
    )
    .all(...cardIds) as { card_id: string; timestamp: string; price: number | null }[]

  const latestByCard = new Map<string, number>()
  const seenDays = new Map<string, Set<string>>()
  const windowMs = 31 * 86_400_000
  for (const r of rows) {
    if (r.price == null) continue
    const ts = Date.parse(r.timestamp)
    if (!Number.isFinite(ts)) continue
    const latest = latestByCard.get(r.card_id) ?? ts
    if (!latestByCard.has(r.card_id)) latestByCard.set(r.card_id, latest)
    if (ts < latest - windowMs) continue

    const day = r.timestamp.slice(0, 10)
    const days = seenDays.get(r.card_id) ?? new Set()
    if (days.has(day)) continue
    days.add(day)
    seenDays.set(r.card_id, days)

    const arr = byCard.get(r.card_id) ?? []
    if (arr.length < 31) arr.push({ p: r.price })
    byCard.set(r.card_id, arr)
  }
  for (const [k, arr] of byCard.entries()) {
    byCard.set(k, [...arr].reverse())
  }
  return byCard
}

function isAnomalyRisky(db: Database, cardId: string): boolean {
  const hist = db
    .prepare(
      `SELECT timestamp, tcgplayer_market
       FROM price_history
       WHERE card_id = ?
         AND tcgplayer_market IS NOT NULL
       ORDER BY timestamp DESC
       LIMIT 8`,
    )
    .all(cardId) as { timestamp: string; tcgplayer_market: number }[]
  if (hist.length < 2) return false
  const newest = hist[0].tcgplayer_market
  const oldest = hist[hist.length - 1].tcgplayer_market
  if (!newest || !oldest || oldest <= 0) return false
  const pct = (newest - oldest) / oldest
  return pct > 0.4
}

function buildRedFlags(card: { predicted_price: number | null; market_price: number | null; rarity: string | null }) {
  const flags: string[] = []
  const p = card.predicted_price ?? 0
  const m = card.market_price ?? 0
  if (p > 0 && m > p * 1.25) flags.push('Listing above model fair by >25%')
  if ((card.rarity ?? '').toLowerCase().includes('trainer')) flags.push('Higher reprint risk profile')
  return flags
}
