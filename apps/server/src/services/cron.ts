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
import { refreshSealedPrices, seedSealedPrices } from './sealedPrices.js'
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
import { invalidateAllPriceHistoryCache, loadAllPriceHistory, loadCardFeatures } from './analytics/shared.js'
import { cacheInvalidateAll, cacheSet } from '../cache.js'
import { saveModelResult } from '../modelStore.js'

let refreshing = false
export function setRefreshing(v: boolean) { refreshing = v }

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

  seedSealedPrices(db)

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

function runAnalyticsModels(db: Database.Database) {
  console.log('[analytics] Pre-warming shared data caches...')
  const t0 = Date.now()
  loadCardFeatures(db)
  loadAllPriceHistory(db)
  console.log(`[analytics] Shared caches warm in ${Date.now() - t0}ms`)

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
    const start = Date.now()
    try {
      const result = run()
      saveModelResult(db, name, result)
      console.log(`[analytics] ${name} done in ${Date.now() - start}ms`)
    } catch (e) { console.error(`[analytics] ${name}:`, e) }
  }
}

export async function fullRefresh(db: Database.Database) {
  seedSealedPrices(db)
  await ingestPokemonTcg(db)
  runFullModel(db)
  recordPriceSnapshot(db)
  takePredictionSnapshot(db)
  await refreshSealedPrices(db).catch(() => {})
  refreshSetMetrics(db)
  invalidateAllPriceHistoryCache()
  cacheInvalidateAll()
  runAnalyticsModels(db)
}
