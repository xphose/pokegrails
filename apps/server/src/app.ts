import cors from 'cors'
import express from 'express'
import type { Database } from 'better-sqlite3'
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

/**
 * Express app with all `/api` routes. Pass a database instance (file or :memory: for tests).
 */
export function createApp(db: Database) {
  const app = express()
  app.use(cors({ origin: true }))
  app.use(express.json())

  app.get('/api/health', (_req, res) => {
    const n = db.prepare(`SELECT COUNT(*) as c FROM cards`).get() as { c: number }
    res.json({ ok: true, cards: n.c })
  })

  app.post('/api/internal/refresh', async (_req, res) => {
    const { fullRefresh } = await import('./services/cron.js')
    try {
      await fullRefresh(db)
      cacheInvalidateAll()
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) })
    }
  })

  app.get('/api/dashboard', (_req, res) => {
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

  app.get('/api/meta/card-filters', (req, res) => {
    const setIdParam = ((req.query.set_id as string) || '').trim()
    const setId = setIdParam.length ? setIdParam : null
    const cacheKey = `GET:/api/meta/card-filters:set=${setId ?? ''}`
    const hit = cacheGet(cacheKey)
    if (hit) {
      res.setHeader('Cache-Control', 'private, max-age=30')
      return res.type('json').send(hit)
    }

    const setsWithMeta = db
      .prepare(
        `SELECT s.id, s.name, s.release_date, s.series, s.total_cards
         FROM sets s
         WHERE s.id IN (SELECT DISTINCT set_id FROM cards WHERE set_id IS NOT NULL)
         ORDER BY CASE WHEN s.release_date IS NULL OR trim(s.release_date) = '' THEN 1 ELSE 0 END ASC,
           s.release_date DESC,
           s.name COLLATE NOCASE ASC`,
      )
      .all() as {
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
    }
    cacheSet(cacheKey, body, 45_000)
    res.setHeader('Cache-Control', 'private, max-age=30')
    res.json(body)
  })

  app.get('/api/cards', (req, res) => {
    const f = parseCardsListFilters(req.query)
    const limitRaw = parseInt(String(req.query.limit ?? '100'), 10)
    const limit = Number.isFinite(limitRaw) ? Math.min(5000, Math.max(1, limitRaw)) : 100
    const offsetRaw = parseInt(String(req.query.offset ?? '0'), 10)
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0

    const baseWhere = `FROM cards WHERE 1=1${f.whereSuffix}`
    const countRow = db.prepare(`SELECT COUNT(*) as c ${baseWhere}`).get(...f.params) as { c: number }
    const total = countRow.c

    const sql = `SELECT * ${baseWhere}${orderByClause(f)} LIMIT ? OFFSET ?`
    const rows = db.prepare(sql).all(...f.params, limit, offset) as {
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
    const sparkByCard = getSparklineMap(db, cardIds)
    const enriched = rows.map((r) => {
      const score = computeAiScore({
        ...r,
        google_trends_score: r.trends_score,
      })
      return {
        ...r,
        ai_score: Number(score.toFixed(4)),
        ai_decision: aiDecision(score),
        spark_30d: sparkByCard.get(r.id) ?? [],
      }
    })

    res.setHeader('Cache-Control', 'no-store')
    res.json({
      items: enriched,
      total,
      limit,
      offset,
    })
  })

  app.get('/api/cards/:id/buy-links', (req, res) => {
    const row = db.prepare(
      `SELECT c.id, c.name, c.set_id, s.name AS set_name
       FROM cards c LEFT JOIN sets s ON c.set_id = s.id
       WHERE c.id = ?`,
    ).get(req.params.id) as
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

  app.get('/api/cards/:id', (req, res) => {
    const row = db.prepare(`SELECT * FROM cards WHERE id = ?`).get(req.params.id)
    if (!row) return res.status(404).json({ error: 'Not found' })
    const hist = db
      .prepare(
        `SELECT timestamp, COALESCE(tcgplayer_market, pricecharting_median) AS tcgplayer_market
         FROM price_history
         WHERE card_id = ?
           AND (tcgplayer_market IS NOT NULL OR pricecharting_median IS NOT NULL)
         ORDER BY timestamp DESC`,
      )
      .all(req.params.id)
    res.json({ card: row, priceHistory: hist })
  })

  app.get('/api/cards/:id/investment', (req, res) => {
    const row = db
      .prepare(
        `SELECT c.*, cp.google_trends_score
         FROM cards c
         LEFT JOIN character_premiums cp ON cp.character_name = c.character_name
         WHERE c.id = ?`,
      )
      .get(req.params.id) as
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

  app.get('/api/signals', (req, res) => {
    const sortParam = ((req.query.sort as string) || 'dollar').toLowerCase()
    const setIdFilter = ((req.query.set_id as string) || '').trim()
    const sortKeys: Record<string, string> = {
      /** Largest gap between fair value and market (absolute $) */
      dollar: `(predicted_price - COALESCE(market_price, 0)) DESC`,
      /** Best % discount vs fair value */
      discount: `CASE
        WHEN predicted_price IS NOT NULL AND predicted_price > 0 AND market_price IS NOT NULL
        THEN (predicted_price - market_price) / predicted_price
        ELSE 0 END DESC`,
      /** Cheapest market first (among signals) */
      market: `(market_price IS NULL), market_price ASC`,
      /** Highest model fair value first */
      fair: `(predicted_price IS NULL), predicted_price DESC`,
      /** Alphabetical */
      name: `name COLLATE NOCASE ASC`,
      /** Group by expansion, then card name */
      set: `(set_id IS NULL), set_id COLLATE NOCASE ASC, name COLLATE NOCASE ASC`,
    }
    const orderBy = sortKeys[sortParam] ?? sortKeys.dollar
    const whereSet = setIdFilter ? ` AND set_id = ?` : ''
    const rows = db
      .prepare(
        `SELECT * FROM cards WHERE valuation_flag LIKE '%UNDERVALUED%'${whereSet}
         ORDER BY ${orderBy} LIMIT 200`,
      )
      .all(...(setIdFilter ? [setIdFilter] : []))
    res.json(rows)
  })

  app.get('/api/alerts', (_req, res) => {
    const rows = db
      .prepare(
        `SELECT c.*, w.target_buy_price, w.alert_active
         FROM cards c
         LEFT JOIN watchlist w ON w.card_id = c.id
         WHERE c.market_price IS NOT NULL
         ORDER BY c.last_updated DESC
         LIMIT 500`,
      )
      .all() as Array<
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

  app.get('/api/sets', (_req, res) => {
    const cacheKey = 'GET:/api/sets'
    const hit = cacheGet(cacheKey)
    if (hit) {
      res.setHeader('Cache-Control', 'private, max-age=30')
      return res.type('json').send(hit)
    }
    const rows = db.prepare(`SELECT * FROM sets ORDER BY release_date DESC`).all()
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
      predictChaseForUpcoming(db, req.params.id)
      const row = db.prepare(`SELECT * FROM upcoming_sets WHERE id = ?`).get(req.params.id)
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
    db.prepare(`DELETE FROM watchlist WHERE id = ?`).run(req.params.id)
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
    db.prepare(`UPDATE cards SET artwork_hype_score = ? WHERE id = ?`).run(Math.min(10, Math.max(1, v)), req.params.id)
    res.json({ ok: true })
  })

  /* ── Sealed product prices ─────────────────────────────────── */

  app.get('/api/sealed-prices/:setId', (req, res) => {
    const rows = db
      .prepare(
        `SELECT set_id, product_type, source, price, packs, fetched_at
         FROM sealed_products WHERE set_id = ? ORDER BY fetched_at DESC`,
      )
      .all(req.params.setId)
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

  app.post('/api/internal/backfill-pricecharting', async (req, res) => {
    const { runPricechartingBackfill } = await import('./services/pricechartingBackfill.js')
    const force = req.query.force === '1' || req.query.force === 'true'
    res.json({ ok: true, message: `Backfill started in background (force=${force}) — watch server console for progress` })
    try {
      const stats = await runPricechartingBackfill(db, { force })
      console.log('[backfill] Finished:', stats)
    } catch (e) {
      console.error('[backfill] Failed:', e)
    }
  })

  app.post('/api/internal/refresh-sealed', async (_req, res) => {
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

  /* ── Analytics model endpoints ─────────────────────────────── */

  app.get('/api/models/timeseries/:cardId', (req, res) => {
    const horizon = Math.min(180, Math.max(7, parseInt(String(req.query.horizon ?? '30'), 10) || 30))
    const result = forecastTimeSeries(db, req.params.cardId, horizon)
    res.json(result)
  })

  app.post('/api/models/gradient-boost/train', (_req, res) => {
    try {
      const model = trainGradientBoostModel(db)
      res.json({ ok: true, trained_at: model.trainedAt, features: model.featureLabels.length })
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) })
    }
  })

  app.get('/api/models/gradient-boost/predict/:cardId', (req, res) => {
    res.json(predictGradientBoost(db, req.params.cardId))
  })

  app.get('/api/models/random-forest/feature-importance', cachedJson(300_000, () => computeFeatureImportance(db)))

  app.get('/api/models/momentum/cards', cachedJson(120_000, (req) => {
    const all = detectMomentumCards(db)
    const limit = clampInt(req.query.limit, 1, 100, 15)
    const offset = clampInt(req.query.offset, 0, all.length, 0)
    return { items: all.slice(offset, offset + limit), total: all.length }
  }))

  app.get('/api/models/momentum/:cardId', (req, res) => {
    res.json(getCardMomentum(db, req.params.cardId))
  })

  app.get('/api/models/sentiment/top-positive', cachedJson(120_000, () => getTopSentiment(db, 'positive')))
  app.get('/api/models/sentiment/top-negative', cachedJson(120_000, () => getTopSentiment(db, 'negative')))

  app.get('/api/models/sentiment/:cardId', (req, res) => {
    res.json(analyzeCardSentiment(db, req.params.cardId))
  })

  app.get('/api/models/supply-shock/alerts', cachedJson(300_000, (req) => {
    const all = detectSupplyShocks(db)
    const limit = clampInt(req.query.limit, 1, 100, 30)
    const offset = clampInt(req.query.offset, 0, all.length, 0)
    return { items: all.slice(offset, offset + limit), total: all.length }
  }))

  app.get('/api/models/anomalies/recent', cachedJson(120_000, (req) => {
    const all = detectAnomalies(db, { days: 30 })
    const limit = clampInt(req.query.limit, 1, 100, 30)
    const offset = clampInt(req.query.offset, 0, all.length, 0)
    return { items: all.slice(offset, offset + limit), total: all.length }
  }))

  app.get('/api/models/anomalies/:cardId', (req, res) => {
    res.json(detectAnomalies(db, { cardId: req.params.cardId }))
  })

  app.get('/api/models/cointegration/pairs', cachedJson(300_000, (req) => {
    const all = findCointegrationPairs(db)
    const limit = clampInt(req.query.limit, 1, 100, 20)
    const offset = clampInt(req.query.offset, 0, all.length, 0)
    return { items: all.slice(offset, offset + limit), total: all.length }
  }))

  app.get('/api/models/cointegration/:cardId', (req, res) => {
    res.json(findCointegrationPairs(db, { cardId: req.params.cardId, limit: 10 }))
  })

  app.get('/api/models/bayesian/estimate/:cardId', (req, res) => {
    res.json(bayesianEstimate(db, req.params.cardId))
  })

  app.get('/api/models/clusters/all', cachedJson(300_000, () => runClustering(db)))

  app.get('/api/models/clusters/:cardId', (req, res) => {
    res.json(getCardCluster(db, req.params.cardId))
  })

  app.get('/api/models/pca/components', cachedJson(300_000, () => computePCA(db)))

  app.get('/api/models/status', (_req, res) => {
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

  app.get('/api/models/progress', (_req, res) => {
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

  app.post('/api/models/run/:modelId', (req, res) => {
    const { modelId } = req.params
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

  app.post('/api/models/run-all', (_req, res) => {
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
      `SELECT card_id, timestamp, COALESCE(tcgplayer_market, pricecharting_median) AS price
       FROM price_history
       WHERE card_id IN (${placeholders})
         AND (tcgplayer_market IS NOT NULL OR pricecharting_median IS NOT NULL)
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
