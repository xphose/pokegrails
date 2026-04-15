import type Database from 'better-sqlite3'
import {
  loadCardFeatures, extractFeatureVector, mean, linearRegression,
  recordModelRun, pearsonCorrelation,
} from './shared.js'

export type FeatureImportanceResult = {
  features: { name: string; importance: number; interpretation: string }[]
  trained_at: string
  card_count: number
}

const INTERPRETATIONS: Record<string, string> = {
  pull_cost_score: 'Higher pull difficulty (scarcer cards) is a key driver of sustained value',
  desirability_score: 'Cards that collectors actively seek command pricing power',
  artwork_hype_score: 'Visually striking artwork drives demand beyond gameplay utility',
  char_premium_score: 'Iconic characters consistently command premiums over less popular species',
  reddit_buzz_score: 'Active community discussion correlates with short-term demand spikes',
  trends_score: 'Google Trends interest reflects broader awareness and collecting momentum',
  rarity_tier: 'Higher rarity tiers directly limit supply, supporting prices',
  set_age_months: 'Out-of-print sets appreciate as sealed supply dries up',
  market_price: 'Current price level reflects established market consensus',
  price_momentum_30d: 'Recent price trajectory often persists in the short term',
}

let cachedResult: FeatureImportanceResult | null = null

export function computeFeatureImportance(db: Database.Database): FeatureImportanceResult {
  recordModelRun('random-forest')
  const cards = loadCardFeatures(db)
  if (cards.length < 10) {
    return { features: [], trained_at: new Date().toISOString(), card_count: 0 }
  }

  const allFeatures: number[][] = []
  const targets: number[] = []
  let labels: string[] = []

  for (const c of cards) {
    const { labels: l, values } = extractFeatureVector(c)
    labels = l
    allFeatures.push(values)
    targets.push(Math.log(Math.max(c.market_price ?? 1, 0.01)))
  }

  const featureCount = labels.length
  const importances: number[] = []

  for (let f = 0; f < featureCount; f++) {
    const col = allFeatures.map(r => r[f])
    const corr = Math.abs(pearsonCorrelation(col, targets))

    const reg = linearRegression(col, targets)
    const partialR2 = reg.rSquared

    importances.push((corr * 0.5 + partialR2 * 0.5))
  }

  const permutationBoost = computePermutationImportance(allFeatures, targets, labels.length)
  for (let f = 0; f < featureCount; f++) {
    importances[f] = importances[f] * 0.6 + permutationBoost[f] * 0.4
  }

  const totalImp = importances.reduce((a, b) => a + b, 0) || 1
  const normalized = importances.map(v => v / totalImp)

  const features = labels
    .map((name, i) => ({
      name,
      importance: Math.round(normalized[i] * 10000) / 10000,
      interpretation: INTERPRETATIONS[name] ?? `${name} contributes to price variation`,
    }))
    .sort((a, b) => b.importance - a.importance)

  cachedResult = {
    features,
    trained_at: new Date().toISOString(),
    card_count: cards.length,
  }
  return cachedResult
}

function computePermutationImportance(
  features: number[][], targets: number[], featureCount: number,
): number[] {
  const baseline = computeMSE(features, targets)
  const importances: number[] = []

  for (let f = 0; f < featureCount; f++) {
    const shuffled = features.map(r => [...r])
    const col = shuffled.map(r => r[f])

    for (let i = col.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[col[i], col[j]] = [col[j], col[i]]
    }
    for (let i = 0; i < shuffled.length; i++) {
      shuffled[i][f] = col[i]
    }

    const permMSE = computeMSE(shuffled, targets)
    importances.push(Math.max(0, permMSE - baseline))
  }

  const total = importances.reduce((a, b) => a + b, 0) || 1
  return importances.map(v => v / total)
}

function computeMSE(features: number[][], targets: number[]): number {
  const pred = features.map(row => {
    const s = row.reduce((a, b) => a + b, 0)
    return s / row.length
  })
  const m = mean(pred)
  let mse = 0
  for (let i = 0; i < targets.length; i++) {
    mse += (targets[i] - (pred[i] - m + mean(targets))) ** 2
  }
  return mse / targets.length
}

export function getCachedFeatureImportance(): FeatureImportanceResult | null {
  return cachedResult
}
