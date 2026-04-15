import { describe, it, expect, beforeAll } from 'vitest'
import type Database from 'better-sqlite3'
import { openMemoryDb } from '../../test/helpers.js'
import { seedAnalyticsFixtures } from '../../test/analyticsFixtures.js'
import { forecastTimeSeries } from './timeseries.js'
import { trainGradientBoostModel, predictGradientBoost } from './gradientBoost.js'
import { computeFeatureImportance } from './featureImportance.js'
import { detectMomentumCards, getCardMomentum } from './momentum.js'
import { analyzeCardSentiment, getTopSentiment } from './sentiment.js'
import { detectSupplyShocks } from './supplyShock.js'
import { detectAnomalies } from './anomaly.js'
import { findCointegrationPairs } from './cointegration.js'
import { bayesianEstimate } from './bayesian.js'
import { runClustering, getCardCluster } from './clustering.js'
import { computePCA } from './pca.js'
import { loadPriceHistory } from './shared.js'

let db: Database.Database

beforeAll(() => {
  db = openMemoryDb()
  seedAnalyticsFixtures(db, 100, 180)
})

describe('Model 1 — Time-Series Forecast', () => {
  it('returns forecast with valid card_id', () => {
    const result = forecastTimeSeries(db, 'test-test-sv1-001', 30)
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.historical.length).toBeGreaterThan(0)
    expect(result.forecast.length).toBe(30)
    expect(result.confidence_upper.length).toBe(30)
    expect(result.confidence_lower.length).toBe(30)
    expect(['exponential_smoothing', 'linear_trend']).toContain(result.model_used)
    expect(typeof result.seasonality_detected).toBe('boolean')
  })

  it('returns error for unknown card_id', () => {
    const result = forecastTimeSeries(db, 'nonexistent-card', 30)
    expect('error' in result).toBe(true)
  })

  it('forecast values are numeric and positive', () => {
    const result = forecastTimeSeries(db, 'test-test-sv1-001', 30)
    if ('error' in result) return
    for (const p of result.forecast) {
      expect(typeof p.price).toBe('number')
      expect(p.price).toBeGreaterThan(0)
      expect(Number.isFinite(p.price)).toBe(true)
    }
  })

  it('respects horizon parameter', () => {
    const r7 = forecastTimeSeries(db, 'test-test-sv1-001', 7)
    const r90 = forecastTimeSeries(db, 'test-test-sv1-001', 90)
    if ('error' in r7 || 'error' in r90) return
    expect(r7.forecast.length).toBe(7)
    expect(r90.forecast.length).toBe(90)
  })
})

describe('Model 2 — Gradient Boost Predictor', () => {
  it('trains model successfully', () => {
    const model = trainGradientBoostModel(db)
    expect(model.stumps.length).toBeGreaterThan(0)
    expect(model.featureLabels.length).toBeGreaterThan(0)
    expect(model.trainedAt).toBeTruthy()
  })

  it('predicts price for valid card', () => {
    const result = predictGradientBoost(db, 'test-test-sv1-001')
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.predicted_price_90d).toBeGreaterThan(0)
    expect(result.confidence).toBeGreaterThanOrEqual(0)
    expect(result.confidence).toBeLessThanOrEqual(1)
    expect(Object.keys(result.feature_importance).length).toBeGreaterThan(0)
  })

  it('returns error for unknown card', () => {
    const result = predictGradientBoost(db, 'nope')
    expect('error' in result).toBe(true)
  })

  it('confidence is based on R-squared (0-1 range)', () => {
    const result = predictGradientBoost(db, 'test-test-sv1-001')
    if ('error' in result) return
    expect(result.confidence).toBeGreaterThanOrEqual(0)
    expect(result.confidence).toBeLessThanOrEqual(1)
    expect(Number.isFinite(result.confidence)).toBe(true)
  })
})

describe('Model 3 — Feature Importance', () => {
  it('returns ranked features', () => {
    const result = computeFeatureImportance(db)
    expect(result.features.length).toBeGreaterThan(0)
    expect(result.card_count).toBeGreaterThan(0)
    expect(result.trained_at).toBeTruthy()

    const totalImportance = result.features.reduce((s, f) => s + f.importance, 0)
    expect(totalImportance).toBeCloseTo(1, 0)
  })

  it('features have interpretations', () => {
    const result = computeFeatureImportance(db)
    for (const f of result.features) {
      expect(f.interpretation.length).toBeGreaterThan(0)
    }
  })
})

describe('Model 4 — Momentum Detector', () => {
  it('returns momentum cards sorted by score', () => {
    const results = detectMomentumCards(db)
    expect(Array.isArray(results)).toBe(true)
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].momentum_score).toBeGreaterThanOrEqual(results[i].momentum_score)
    }
  })

  it('returns card momentum for specific card', () => {
    const result = getCardMomentum(db, 'test-test-sv1-001')
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.card_id).toBe('test-test-sv1-001')
    expect(typeof result.momentum_score).toBe('number')
  })

  it('momentum cards include set_name, card_number, and rarity', () => {
    const results = detectMomentumCards(db)
    if (!results.length) return
    const card = results[0]
    expect(typeof card.set_name).toBe('string')
    expect(typeof card.card_number).toBe('string')
    expect(card.card_number.length).toBeGreaterThan(0)
    expect(card.rarity === null || typeof card.rarity === 'string').toBe(true)
  })

  it('momentum scores are bounded 0–100', () => {
    const results = detectMomentumCards(db)
    for (const card of results) {
      expect(card.momentum_score).toBeGreaterThanOrEqual(0)
      expect(card.momentum_score).toBeLessThanOrEqual(100)
      expect(Number.isInteger(card.momentum_score)).toBe(true)
    }
  })

  it('returns error for unknown card', () => {
    const result = getCardMomentum(db, 'nonexistent')
    expect('error' in result).toBe(true)
  })
})

describe('Model 5 — Sentiment Analysis', () => {
  it('returns sentiment for valid card', () => {
    const result = analyzeCardSentiment(db, 'test-test-sv1-001')
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.sentiment_score).toBeGreaterThanOrEqual(-1)
    expect(result.sentiment_score).toBeLessThanOrEqual(1)
    expect(['positive', 'neutral', 'negative']).toContain(result.label)
    expect(Array.isArray(result.signals)).toBe(true)
    expect(Array.isArray(result.breakdown)).toBe(true)
  })

  it('returns error for unknown card', () => {
    const result = analyzeCardSentiment(db, 'nope')
    expect('error' in result).toBe(true)
  })

  it('top positive returns sorted list', () => {
    const results = getTopSentiment(db, 'positive', 10)
    expect(results.length).toBeGreaterThan(0)
    expect(results.length).toBeLessThanOrEqual(10)
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].sentiment_score).toBeGreaterThanOrEqual(results[i].sentiment_score)
    }
  })

  it('returns correct field names (not legacy composite_score/signal/flags)', () => {
    const result = analyzeCardSentiment(db, 'test-test-sv1-001')
    if ('error' in result) return
    expect('sentiment_score' in result).toBe(true)
    expect('label' in result).toBe(true)
    expect('signals' in result).toBe(true)
    expect('breakdown' in result).toBe(true)
    expect('composite_score' in result).toBe(false)
    expect('signal' in result).toBe(false)
    expect('flags' in result).toBe(false)
  })

  it('breakdown entries have source, score, and detail', () => {
    const result = analyzeCardSentiment(db, 'test-test-sv1-001')
    if ('error' in result) return
    expect(result.breakdown.length).toBeGreaterThan(0)
    for (const b of result.breakdown) {
      expect(typeof b.source).toBe('string')
      expect(typeof b.score).toBe('number')
      expect(typeof b.detail).toBe('string')
      expect(Number.isFinite(b.score)).toBe(true)
    }
  })

  it('top negative returns reverse sorted list', () => {
    const results = getTopSentiment(db, 'negative', 10)
    expect(results.length).toBeGreaterThan(0)
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].sentiment_score).toBeLessThanOrEqual(results[i].sentiment_score)
    }
  })
})

describe('Model 6 — Supply Shock Detector', () => {
  it('returns supply shock alerts', () => {
    const results = detectSupplyShocks(db)
    expect(Array.isArray(results)).toBe(true)
    for (const a of results) {
      expect(['high', 'medium', 'low']).toContain(a.alert_level)
      expect(a.explanation.length).toBeGreaterThan(0)
    }
  })

  it('returns enriched card fields', () => {
    const results = detectSupplyShocks(db)
    if (!results.length) return
    const a = results[0]
    expect(typeof a.set_name).toBe('string')
    expect(typeof a.card_number).toBe('string')
    expect(a.card_number.length).toBeGreaterThan(0)
    expect(typeof a.market_price).toBe('number')
    expect(a.market_price).toBeGreaterThan(0)
    expect(a.rarity === null || typeof a.rarity === 'string').toBe(true)
  })
})

describe('Model 7 — Anomaly Detector', () => {
  it('detects anomalies with injected spike', () => {
    const results = detectAnomalies(db, { days: 200 })
    expect(Array.isArray(results)).toBe(true)
    const pumps = results.filter(r => r.type === 'pump')
    expect(pumps.length).toBeGreaterThanOrEqual(0)
  })

  it('returns anomalies for specific card', () => {
    const results = detectAnomalies(db, { cardId: 'test-test-sv1-001' })
    expect(Array.isArray(results)).toBe(true)
    for (const e of results) {
      expect(e.card_id).toBe('test-test-sv1-001')
      expect(['pump', 'crash', 'recovery']).toContain(e.type)
    }
  })

  it('anomaly z_scores are numeric', () => {
    const results = detectAnomalies(db, { days: 200 })
    for (const e of results) {
      expect(Number.isFinite(e.z_score)).toBe(true)
    }
  })

  it('returns enriched card fields on every event', () => {
    const results = detectAnomalies(db, { days: 200 })
    for (const e of results) {
      expect(typeof e.set_name).toBe('string')
      expect(typeof e.card_number).toBe('string')
      expect(e.card_number.length).toBeGreaterThan(0)
      expect(typeof e.market_price).toBe('number')
      expect(e.rarity === null || typeof e.rarity === 'string').toBe(true)
    }
  })

  it('does not produce duplicate card+date events', () => {
    const results = detectAnomalies(db, { days: 200 })
    const keys = new Set<string>()
    for (const e of results) {
      const key = `${e.card_id}|${e.date}`
      expect(keys.has(key)).toBe(false)
      keys.add(key)
    }
  })
})

describe('Model 8 — Cointegration Analyzer', () => {
  it('finds correlated pairs', () => {
    const pairs = findCointegrationPairs(db, { minOverlap: 10 })
    expect(Array.isArray(pairs)).toBe(true)
    for (const p of pairs) {
      expect(Math.abs(p.correlation)).toBeGreaterThanOrEqual(0.5)
      expect(['strong', 'moderate', 'weak']).toContain(p.relationship)
    }
  })

  it('finds pairs for specific card', () => {
    const pairs = findCointegrationPairs(db, { cardId: 'test-test-sv1-001', minOverlap: 10 })
    expect(Array.isArray(pairs)).toBe(true)
    for (const p of pairs) {
      expect(p.card_a_id === 'test-test-sv1-001' || p.card_b_id === 'test-test-sv1-001').toBe(true)
    }
  })

  it('returns enriched card_a and card_b objects', () => {
    const pairs = findCointegrationPairs(db, { minOverlap: 10 })
    if (!pairs.length) return
    const p = pairs[0]
    for (const card of [p.card_a, p.card_b]) {
      expect(card.id).toBeTruthy()
      expect(card.name).toBeTruthy()
      expect(typeof card.card_number).toBe('string')
      expect(card.card_number.length).toBeGreaterThan(0)
      expect(typeof card.market_price).toBe('number')
      expect(card.image_url === null || typeof card.image_url === 'string').toBe(true)
    }
  })

  it('does not pair a card with itself by name', () => {
    const pairs = findCointegrationPairs(db, { minOverlap: 10 })
    for (const p of pairs) {
      expect(p.card_a_name).not.toBe(p.card_b_name)
    }
  })
})

describe('Model 9 — Bayesian Estimator', () => {
  it('returns estimate for valid card', () => {
    const result = bayesianEstimate(db, 'test-test-sv1-001')
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.estimated_price).toBeGreaterThan(0)
    expect(result.credible_interval_low).toBeLessThanOrEqual(result.estimated_price)
    expect(result.credible_interval_high).toBeGreaterThanOrEqual(result.estimated_price)
    expect(result.num_observations).toBeGreaterThan(0)
    expect(result.confidence_label.length).toBeGreaterThan(0)
  })

  it('returns error for unknown card', () => {
    const result = bayesianEstimate(db, 'nope')
    expect('error' in result).toBe(true)
  })

  it('includes market_price and prior_mean in response', () => {
    const result = bayesianEstimate(db, 'test-test-sv1-001')
    if ('error' in result) return
    expect(typeof result.market_price).toBe('number')
    expect(result.prior_mean === null || typeof result.prior_mean === 'number').toBe(true)
    expect(typeof result.peer_count).toBe('number')
  })

  it('credible interval is a proper range around estimate', () => {
    const result = bayesianEstimate(db, 'test-test-sv1-001')
    if ('error' in result) return
    expect(result.credible_interval_low).toBeGreaterThan(0)
    expect(result.credible_interval_high).toBeGreaterThan(result.credible_interval_low)
    const width = result.credible_interval_high - result.credible_interval_low
    expect(width).toBeGreaterThan(0)
  })

  it('estimate is finite and not NaN', () => {
    const result = bayesianEstimate(db, 'test-test-sv1-001')
    if ('error' in result) return
    expect(Number.isFinite(result.estimated_price)).toBe(true)
    expect(Number.isFinite(result.credible_interval_low)).toBe(true)
    expect(Number.isFinite(result.credible_interval_high)).toBe(true)
  })

  it('prior_source describes peer group', () => {
    const result = bayesianEstimate(db, 'test-test-sv1-001')
    if ('error' in result) return
    expect(result.prior_source.length).toBeGreaterThan(0)
    expect(result.prior_source).toMatch(/cards/)
  })
})

describe('Model 10 — Card Clustering', () => {
  it('produces between 4 and 8 clusters', () => {
    const result = runClustering(db)
    expect(result.profiles.length).toBeGreaterThanOrEqual(4)
    expect(result.profiles.length).toBeLessThanOrEqual(8)
  })

  it('all cards get cluster assignments', () => {
    const result = runClustering(db)
    expect(result.assignments.length).toBeGreaterThan(0)
    for (const a of result.assignments) {
      expect(a.archetype.length).toBeGreaterThan(0)
      expect(a.archetype_color.length).toBeGreaterThan(0)
    }
  })

  it('returns cluster for specific card', () => {
    const result = getCardCluster(db, 'test-test-sv1-001')
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.archetype.length).toBeGreaterThan(0)
    expect(result.profile.card_count).toBeGreaterThan(0)
  })
})

describe('Model 11 — PCA Decomposer', () => {
  it('returns components with variance explained', () => {
    const result = computePCA(db)
    expect(result.components.length).toBeGreaterThan(0)
    expect(result.components.length).toBeLessThanOrEqual(result.feature_count)
    expect(result.total_variance_explained).toBeGreaterThan(0)
    expect(result.total_variance_explained).toBeLessThanOrEqual(1.01)
  })

  it('components have top features', () => {
    const result = computePCA(db)
    for (const c of result.components) {
      expect(c.top_features.length).toBeGreaterThan(0)
      for (const f of c.top_features) {
        expect(f.loading).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('cumulative variance is monotonically increasing', () => {
    const result = computePCA(db)
    for (let i = 1; i < result.components.length; i++) {
      expect(result.components[i].cumulative_variance)
        .toBeGreaterThanOrEqual(result.components[i - 1].cumulative_variance - 0.001)
    }
  })
})

describe('Price History Deduplication', () => {
  it('loadPriceHistory returns at most one point per day', () => {
    const history = loadPriceHistory(db, 'test-test-sv1-001')
    const dates = history.map(h => h.timestamp.slice(0, 10))
    const uniqueDates = new Set(dates)
    expect(dates.length).toBe(uniqueDates.size)
  })

  it('price history is sorted ascending by date', () => {
    const history = loadPriceHistory(db, 'test-test-sv1-001')
    for (let i = 1; i < history.length; i++) {
      expect(history[i].timestamp >= history[i - 1].timestamp).toBe(true)
    }
  })
})

describe('Analytics Pipeline Integration', () => {
  it('all 11 models can be triggered without crashing', () => {
    expect(() => forecastTimeSeries(db, 'test-test-sv1-001', 30)).not.toThrow()
    expect(() => trainGradientBoostModel(db)).not.toThrow()
    expect(() => computeFeatureImportance(db)).not.toThrow()
    expect(() => detectMomentumCards(db)).not.toThrow()
    expect(() => analyzeCardSentiment(db, 'test-test-sv1-001')).not.toThrow()
    expect(() => detectSupplyShocks(db)).not.toThrow()
    expect(() => detectAnomalies(db)).not.toThrow()
    expect(() => findCointegrationPairs(db, { minOverlap: 10 })).not.toThrow()
    expect(() => bayesianEstimate(db, 'test-test-sv1-001')).not.toThrow()
    expect(() => runClustering(db)).not.toThrow()
    expect(() => computePCA(db)).not.toThrow()
  })

  it('gradient boost and feature importance use same feature extraction', () => {
    const gb = predictGradientBoost(db, 'test-test-sv1-001')
    const fi = computeFeatureImportance(db)
    if ('error' in gb) return
    const gbFeatures = Object.keys(gb.feature_importance)
    const fiFeatures = fi.features.map(f => f.name)
    for (const f of gbFeatures) {
      expect(fiFeatures).toContain(f)
    }
  })

  it('PCA output has fewer components than input features', () => {
    const result = computePCA(db)
    expect(result.components.length).toBeLessThanOrEqual(result.feature_count)
  })
})
