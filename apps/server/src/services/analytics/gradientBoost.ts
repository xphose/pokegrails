import type Database from 'better-sqlite3'
import {
  loadCardFeatures, extractFeatureVector, mean, recordModelRun,
  linearRegression, type CardFeatureRow,
} from './shared.js'

export type GradientBoostPrediction = {
  predicted_price_90d: number
  confidence: number
  feature_importance: Record<string, number>
  trained_at: string
}

type TreeStump = {
  featureIdx: number
  threshold: number
  leftVal: number
  rightVal: number
}

type TrainedModel = {
  stumps: TreeStump[]
  learningRate: number
  basePrediction: number
  featureLabels: string[]
  trainedAt: string
  importance: number[]
  trainRSquared: number
}

let cachedModel: TrainedModel | null = null

function bestStump(features: number[][], residuals: number[], featureCount: number): TreeStump {
  let bestLoss = Infinity
  let best: TreeStump = { featureIdx: 0, threshold: 0, leftVal: 0, rightVal: 0 }

  for (let f = 0; f < featureCount; f++) {
    const vals = [...new Set(features.map(r => r[f]))].sort((a, b) => a - b)
    const thresholds = vals.length > 20
      ? vals.filter((_, i) => i % Math.ceil(vals.length / 20) === 0)
      : vals

    for (const t of thresholds) {
      const leftRes: number[] = []
      const rightRes: number[] = []
      for (let i = 0; i < features.length; i++) {
        if (features[i][f] <= t) leftRes.push(residuals[i])
        else rightRes.push(residuals[i])
      }
      if (!leftRes.length || !rightRes.length) continue

      const lm = mean(leftRes)
      const rm = mean(rightRes)
      let loss = 0
      for (const r of leftRes) loss += (r - lm) ** 2
      for (const r of rightRes) loss += (r - rm) ** 2

      if (loss < bestLoss) {
        bestLoss = loss
        best = { featureIdx: f, threshold: t, leftVal: lm, rightVal: rm }
      }
    }
  }
  return best
}

function predictStumps(stumps: TreeStump[], lr: number, base: number, features: number[]): number {
  let pred = base
  for (const s of stumps) {
    pred += lr * (features[s.featureIdx] <= s.threshold ? s.leftVal : s.rightVal)
  }
  return Math.max(0.01, pred)
}

export function trainGradientBoostModel(db: Database.Database): TrainedModel {
  recordModelRun('gradient-boost')
  const cards = loadCardFeatures(db)
  if (cards.length < 10) {
    const now = new Date().toISOString()
    cachedModel = {
      stumps: [], learningRate: 0.1, basePrediction: 5,
      featureLabels: [], trainedAt: now, importance: [], trainRSquared: 0,
    }
    return cachedModel
  }

  const features: number[][] = []
  const targets: number[] = []
  let featureLabels: string[] = []

  for (const c of cards) {
    const { labels, values } = extractFeatureVector(c)
    featureLabels = labels
    features.push(values)
    targets.push(Math.log(Math.max(c.market_price ?? 1, 0.01)))
  }

  const basePrediction = mean(targets)
  const residuals = targets.map(t => t - basePrediction)
  const numRounds = 200
  const lr = 0.15
  const stumps: TreeStump[] = []
  const importanceAccum = new Array(featureLabels.length).fill(0)

  for (let round = 0; round < numRounds; round++) {
    const stump = bestStump(features, residuals, featureLabels.length)
    stumps.push(stump)
    importanceAccum[stump.featureIdx] += 1

    for (let i = 0; i < features.length; i++) {
      const pred = features[i][stump.featureIdx] <= stump.threshold ? stump.leftVal : stump.rightVal
      residuals[i] -= lr * pred
    }
  }

  const impSum = importanceAccum.reduce((a, b) => a + b, 0) || 1
  const importance = importanceAccum.map(v => v / impSum)

  const ssRes = residuals.reduce((s, r) => s + r * r, 0)
  const ssTot = targets.reduce((s, t) => s + (t - basePrediction) ** 2, 0)
  const trainRSquared = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0

  const trainedAt = new Date().toISOString()
  cachedModel = { stumps, learningRate: lr, basePrediction, featureLabels, trainedAt, importance, trainRSquared }
  return cachedModel
}

export function predictGradientBoost(
  db: Database.Database,
  cardId: string,
): GradientBoostPrediction | { error: string } {
  const card = db.prepare(`
    SELECT c.*, s.release_date AS set_release_date
    FROM cards c LEFT JOIN sets s ON s.id = c.set_id
    WHERE c.id = ?
  `).get(cardId) as CardFeatureRow | undefined

  if (!card) return { error: 'Card not found' }

  let model = cachedModel
  if (!model) model = trainGradientBoostModel(db)
  if (!model.stumps.length) {
    return { error: 'Model not trained — insufficient card data' }
  }

  const { values } = extractFeatureVector(card)
  const logPred = predictStumps(model.stumps, model.learningRate, model.basePrediction, values)
  const predicted = Math.exp(logPred)

  const confidence = Math.round(model.trainRSquared * 1000) / 1000

  const importanceMap: Record<string, number> = {}
  for (let i = 0; i < model.featureLabels.length; i++) {
    importanceMap[model.featureLabels[i]] = Math.round(model.importance[i] * 10000) / 10000
  }

  return {
    predicted_price_90d: Math.round(predicted * 100) / 100,
    confidence,
    feature_importance: importanceMap,
    trained_at: model.trainedAt,
  }
}
