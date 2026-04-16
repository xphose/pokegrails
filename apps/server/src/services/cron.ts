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

function runAnalyticsModels(db: Database.Database) {
  const models: [string, () => void][] = [
    ['gradient-boost', () => { trainGradientBoostModel(db) }],
    ['feature-importance', () => { computeFeatureImportance(db) }],
    ['momentum', () => { detectMomentumCards(db) }],
    ['supply-shock', () => { detectSupplyShocks(db) }],
    ['anomaly', () => { detectAnomalies(db, { days: 30 }) }],
    ['cointegration', () => { findCointegrationPairs(db) }],
  ]
  for (const [name, run] of models) {
    try { run() } catch (e) { console.error(`[analytics] ${name}:`, e) }
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
  runAnalyticsModels(db)
}
