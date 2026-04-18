import cron from 'node-cron'
import type Database from 'better-sqlite3'
import { ingestPokemonTcg } from './pokemontcg.js'
import { runFullModel } from './model.js'
import { pollRedditOptimized } from './reddit.js'
import { refreshTrendsForAllCharacters } from './trends.js'
import { refreshEbayMediansForCards } from './ebay.js'
import { recordPriceSnapshot } from './priceHistory.js'
import { refreshSetMetrics } from './setMetrics.js'
import { notifyPriceAlerts } from './push.js'
import { refreshSealedPrices } from './sealedPrices.js'
import { runPricechartingBackfill } from './pricechartingBackfill.js'
import { runPcCsvIngest } from './pricechartingCsv.js'
import { scrubPriceHistory } from './priceHistoryScrub.js'
import { takePredictionSnapshot } from './trackRecord.js'
import { trainGradientBoostModel } from './analytics/gradientBoost.js'
import { computeFeatureImportance } from './analytics/featureImportance.js'
import { detectMomentumCards } from './analytics/momentum.js'
import { detectSupplyShocks } from './analytics/supplyShock.js'
import { detectAnomalies } from './analytics/anomaly.js'
import { findCointegrationPairs } from './analytics/cointegration.js'
import { runClustering } from './analytics/clustering.js'
import { computePCA } from './analytics/pca.js'
import { getTopSentiment } from './analytics/sentiment.js'
import { invalidateAllPriceHistoryCache } from './analytics/shared.js'
import { cacheInvalidateAll, cacheSet } from '../cache.js'
import { saveModelResult } from '../modelStore.js'

let refreshing = false
export function setRefreshing(v: boolean) { refreshing = v }

const yieldEventLoop = () => new Promise<void>(resolve => setImmediate(resolve))

export function startCronJobs(db: Database.Database) {
  const safe = (name: string, fn: () => void | Promise<void>) => async () => {
    if (refreshing) return
    refreshing = true
    try {
      await Promise.resolve(fn())
    } catch (e) {
      console.error(`[cron ${name}]`, e)
    } finally {
      refreshing = false
    }
  }

  cron.schedule('0 */4 * * *', safe('prices', () => fullRefresh(db)))
  cron.schedule('0 */6 * * *', safe('ebay', () => refreshEbayMediansForCards(db)))
  cron.schedule('30 * * * *', safe('snapshot', () => recordPriceSnapshot(db)))
  cron.schedule('*/30 * * * *', safe('reddit', async () => {
    await pollRedditOptimized(db)
  }))
  cron.schedule('0 3 * * *', safe('trends', () => refreshTrendsForAllCharacters(db)))
  cron.schedule('0 4 * * 0', safe('regression', () => runFullModel(db)))
  cron.schedule('0 0 * * *', safe('prediction-snapshot', () => takePredictionSnapshot(db)))
  cron.schedule('*/15 * * * *', safe('alerts', () => notifyPriceAlerts(db)))
  cron.schedule('0 */12 * * *', safe('sealed', async () => { await refreshSealedPrices(db) }))

  // Daily bulk PriceCharting CSV pull: ONE HTTP call (~12 MB) refreshes
  // prices for every card with a known `pricecharting_id` and appends a
  // dated snapshot to `card_grade_history`. Runs at 02:00 UTC to dodge
  // PC's mid-day update window. This is the steady-state path — fast,
  // single-request, IP-rate-limit friendly.
  cron.schedule('0 2 * * *', safe('pc-csv', async () => {
    await runPcCsvIngest(db)
  }))

  // Weekly PriceCharting Phase 1/2/3 backfill: discovers + fuzzy-matches
  // NEW cards (where the CSV's `tcg-id` doesn't help us) and scrapes the
  // longer historical chart for those new matches ONLY. Phase 3 is gated
  // by an idempotency check that skips any card already having
  // card_grade_history rows tagged source='pricecharting-chart' — so this
  // never re-fetches history for the ~5,700 cards backfilled via
  // scripts/pc-history-scrape.mjs on 2026-04-18. Runs Sunday 03:00 UTC.
  // The circuit breaker in pricechartingBackfill.ts auto-aborts if the
  // prod IP gets rate-limited, so this won't make a Cloudflare ban worse.
  cron.schedule('0 3 * * 0', safe('pc-backfill', async () => {
    await runPricechartingBackfill(db, { force: false })
  }))

  // Weekly scrub pass: re-checks all of `price_history` against the latest
  // PriceCharting anchor + 14-day MAD window + spike-and-revert detector,
  // purging any outliers that slipped through the ingest gates. Runs weekly
  // rather than daily because PC data has to settle first and the scrub
  // touches every card.
  cron.schedule('0 4 * * 0', safe('price-scrub', async () => {
    const result = scrubPriceHistory(db)
    console.log('[cron price-scrub]', result)
  }))
}

const HTTP_CACHE_TTL = 1_800_000

/**
 * On startup, hydrate the HTTP response cache from persisted model_results
 * so the first user request is instant (no recomputation needed).
 */
export function hydrateFromDb(db: Database.Database) {
  const rows = db.prepare(`SELECT model_id, result_json FROM model_results`).all() as
    { model_id: string; result_json: string }[]
  if (!rows.length) {
    console.log('[analytics] No persisted model results found — cold start required')
    return
  }
  const cacheMap: Record<string, string> = {
    'feature-importance': 'GET:/api/models/random-forest/feature-importance',
    'momentum': 'GET:/api/models/momentum/cards',
    'supply-shock': 'GET:/api/models/supply-shock/alerts',
    'anomaly': 'GET:/api/models/anomalies/recent',
    'cointegration': 'GET:/api/models/cointegration/pairs',
    'clustering': 'GET:/api/models/clusters/all',
    'pca': 'GET:/api/models/pca/components',
    'sentiment-positive': 'GET:/api/models/sentiment/top-positive',
    'sentiment-negative': 'GET:/api/models/sentiment/top-negative',
  }
  let count = 0
  for (const row of rows) {
    const cacheKey = cacheMap[row.model_id]
    if (cacheKey) {
      cacheSet(cacheKey, row.result_json, HTTP_CACHE_TTL)
      count++
    }
  }
  console.log(`[analytics] Hydrated ${count} model results from SQLite — instant startup`)
}

async function runAnalyticsModels(db: Database.Database) {
  console.log('[analytics] Running analytics models...')

  const models: [string, () => unknown][] = [
    ['gradient-boost', () => trainGradientBoostModel(db)],
    ['feature-importance', () => computeFeatureImportance(db)],
    ['momentum', () => {
      const all = detectMomentumCards(db)
      return { items: all, total: all.length }
    }],
    ['supply-shock', () => {
      const all = detectSupplyShocks(db)
      return { items: all, total: all.length }
    }],
    ['anomaly', () => {
      const all = detectAnomalies(db, { days: 30 })
      return { items: all, total: all.length }
    }],
    ['cointegration', () => {
      const all = findCointegrationPairs(db)
      return { items: all, total: all.length }
    }],
    ['clustering', () => {
      const { profiles } = runClustering(db)
      return { profiles }
    }],
    ['pca', () => computePCA(db)],
    ['sentiment-positive', () => getTopSentiment(db, 'positive')],
    ['sentiment-negative', () => getTopSentiment(db, 'negative')],
  ]
  for (const [name, run] of models) {
    await yieldEventLoop()
    const start = Date.now()
    try {
      const result = run()
      saveModelResult(db, name, result)
      console.log(`[analytics] ${name} done in ${Date.now() - start}ms`)
    } catch (e) { console.error(`[analytics] ${name}:`, e) }
  }
}

/**
 * Ingest + model refresh without analytics recomputation.
 * Safe for startup — analytics results are served from SQLite via hydrateFromDb.
 */
export async function dataRefresh(db: Database.Database) {
  await ingestPokemonTcg(db)
  await yieldEventLoop()
  runFullModel(db)
  await yieldEventLoop()
  recordPriceSnapshot(db)
  takePredictionSnapshot(db)
  await yieldEventLoop()
  await refreshSealedPrices(db).catch(() => {})
  await yieldEventLoop()
  refreshSetMetrics(db)
  cacheInvalidateAll()
}

/**
 * Full refresh: data ingest + analytics model recomputation.
 * Only called from the 4-hour cron schedule and admin manual trigger.
 */
export async function fullRefresh(db: Database.Database) {
  await dataRefresh(db)
  invalidateAllPriceHistoryCache()
  await runAnalyticsModels(db)
}
