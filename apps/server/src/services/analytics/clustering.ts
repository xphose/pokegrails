import type Database from 'better-sqlite3'
import {
  loadCardFeatures, loadAllPriceHistory, mean, stddev,
  normalize, recordModelRun, type CardFeatureRow,
} from './shared.js'

export type ClusterAssignment = {
  card_id: string
  name: string
  cluster_id: number
  archetype: string
  archetype_color: string
  confidence: number
}

export type ClusterProfile = {
  cluster_id: number
  archetype: string
  archetype_color: string
  description: string
  card_count: number
  avg_price: number
  avg_volatility: number
  avg_growth: number
}

const ARCHETYPE_TEMPLATES = [
  { name: 'Blue Chips', color: '#3b82f6', desc: 'High-value, stable cards with consistent demand and low volatility' },
  { name: 'Hype Cyclicals', color: '#f59e0b', desc: 'High volatility, boom-bust patterns driven by trends and hype cycles' },
  { name: 'Slow Burners', color: '#10b981', desc: 'Steady, quiet appreciation — underappreciated cards with reliable growth' },
  { name: 'Sleepers', color: '#8b5cf6', desc: 'Low-price cards with untapped upside potential waiting for a catalyst' },
  { name: 'Dead Weight', color: '#6b7280', desc: 'Declining or stagnant cards with high supply and weak demand signals' },
  { name: 'Momentum Plays', color: '#ef4444', desc: 'Currently surging cards with strong recent price momentum' },
]

type FeatureVec = { cardId: string; name: string; features: number[] }

function buildClusterFeatures(
  cards: CardFeatureRow[],
  historyMap: Map<string, { timestamp: string; price: number }[]>,
): FeatureVec[] {
  const vecs: FeatureVec[] = []

  for (const c of cards) {
    const hist = historyMap.get(c.id) ?? []
    const prices = hist.map(h => h.price)

    const volatility = prices.length >= 3 ? stddev(prices) / (mean(prices) || 1) : 0.3
    const growth = c.annual_growth_rate ?? 0
    const priceLevel = Math.log(Math.max(c.market_price ?? 1, 0.01))
    const liquidity = Math.min(1, prices.length / 60)
    const desirability = (c.desirability_score ?? 5) / 10
    const pullCost = (c.pull_cost_score ?? 5) / 10
    const momentum = prices.length >= 5
      ? (prices[prices.length - 1] - prices[Math.max(0, prices.length - 10)]) /
        (prices[Math.max(0, prices.length - 10)] || 1)
      : 0

    vecs.push({
      cardId: c.id,
      name: c.name,
      features: [volatility, growth, priceLevel, liquidity, desirability, pullCost, momentum],
    })
  }

  return vecs
}

function kMeans(
  data: number[][],
  k: number,
  maxIter = 50,
): { assignments: number[]; centroids: number[][] } {
  const n = data.length
  const dim = data[0]?.length ?? 0
  if (n === 0 || dim === 0) return { assignments: [], centroids: [] }

  const centroids: number[][] = []
  const used = new Set<number>()
  for (let i = 0; i < k; i++) {
    let idx: number
    do { idx = Math.floor(Math.random() * n) } while (used.has(idx) && used.size < n)
    used.add(idx)
    centroids.push([...data[idx]])
  }

  const assignments = new Int32Array(n)
  const clusterCounts = new Int32Array(k)
  const centroidSums = new Float64Array(k * dim)

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false
    for (let i = 0; i < n; i++) {
      let bestDist = Infinity
      let bestC = 0
      for (let c = 0; c < k; c++) {
        let dist = 0
        for (let d = 0; d < dim; d++) dist += (data[i][d] - centroids[c][d]) ** 2
        if (dist < bestDist) {
          bestDist = dist
          bestC = c
        }
      }
      if (bestC !== assignments[i]) changed = true
      assignments[i] = bestC
    }

    if (!changed) break

    clusterCounts.fill(0)
    centroidSums.fill(0)
    for (let i = 0; i < n; i++) {
      const c = assignments[i]
      clusterCounts[c]++
      const base = c * dim
      for (let d = 0; d < dim; d++) centroidSums[base + d] += data[i][d]
    }
    for (let c = 0; c < k; c++) {
      if (clusterCounts[c] === 0) continue
      const base = c * dim
      for (let d = 0; d < dim; d++) centroids[c][d] = centroidSums[base + d] / clusterCounts[c]
    }
  }

  return { assignments: Array.from(assignments), centroids }
}

function silhouetteScore(data: number[][], assignments: number[], k: number): number {
  const n = data.length
  if (n < 2 || k < 2) return 0

  const clusterIndices: number[][] = Array.from({ length: k }, () => [])
  for (let i = 0; i < n; i++) clusterIndices[assignments[i]].push(i)

  const clusterCentroids: number[][] = clusterIndices.map(indices => {
    if (!indices.length) return data[0].map(() => 0)
    const dim = data[0].length
    const centroid = new Array(dim).fill(0)
    for (const idx of indices) {
      for (let d = 0; d < dim; d++) centroid[d] += data[idx][d]
    }
    for (let d = 0; d < dim; d++) centroid[d] /= indices.length
    return centroid
  })

  const SAMPLE_SIZE = Math.min(n, 500)
  const sampleIndices: number[] = []
  if (SAMPLE_SIZE >= n) {
    for (let i = 0; i < n; i++) sampleIndices.push(i)
  } else {
    const step = n / SAMPLE_SIZE
    for (let s = 0; s < SAMPLE_SIZE; s++) {
      sampleIndices.push(Math.min(Math.floor(s * step), n - 1))
    }
  }

  let totalSil = 0
  for (const i of sampleIndices) {
    const ci = assignments[i]
    const myCluster = clusterIndices[ci]
    let a = 0
    if (myCluster.length > 1) {
      let sumDist = 0
      for (const j of myCluster) {
        if (j === i) continue
        let dist = 0
        for (let d = 0; d < data[0].length; d++) dist += (data[i][d] - data[j][d]) ** 2
        sumDist += Math.sqrt(dist)
      }
      a = sumDist / (myCluster.length - 1)
    }

    let minB = Infinity
    for (let c = 0; c < k; c++) {
      if (c === ci || !clusterIndices[c].length) continue
      let dist = 0
      for (let d = 0; d < data[0].length; d++) dist += (data[i][d] - clusterCentroids[c][d]) ** 2
      const b = Math.sqrt(dist)
      if (b < minB) minB = b
    }

    if (minB === Infinity) continue
    totalSil += (minB - a) / Math.max(a, minB)
  }

  return totalSil / sampleIndices.length
}

function assignArchetypes(centroids: number[][]): number[] {
  const mapping: number[] = []

  const centroidScores = centroids.map((c, i) => ({
    idx: i,
    volatility: c[0],
    growth: c[1],
    priceLevel: c[2],
    liquidity: c[3],
    desirability: c[4],
    momentum: c[6],
  }))

  centroidScores.sort((a, b) => b.priceLevel - a.priceLevel)

  const archetypeIdx = new Map<number, number>()
  const used = new Set<number>()

  for (const cs of centroidScores) {
    let best = 0
    if (cs.priceLevel > 2 && cs.volatility < 0.3 && !used.has(0)) best = 0
    else if (cs.volatility > 0.4 && !used.has(1)) best = 1
    else if (cs.growth > 0.05 && cs.volatility < 0.3 && !used.has(2)) best = 2
    else if (cs.priceLevel < 1.5 && cs.desirability > 0.4 && !used.has(3)) best = 3
    else if (cs.growth < -0.02 && !used.has(4)) best = 4
    else if (cs.momentum > 0.1 && !used.has(5)) best = 5
    else {
      for (let a = 0; a < ARCHETYPE_TEMPLATES.length; a++) {
        if (!used.has(a)) { best = a; break }
      }
    }

    used.add(best)
    archetypeIdx.set(cs.idx, best)
  }

  for (let i = 0; i < centroids.length; i++) {
    mapping.push(archetypeIdx.get(i) ?? 4)
  }

  return mapping
}

let cachedClusters: { assignments: ClusterAssignment[]; profiles: ClusterProfile[]; expiresAt: number } | null = null
const CLUSTERING_TTL = 600_000

export function runClustering(db: Database.Database): {
  assignments: ClusterAssignment[]
  profiles: ClusterProfile[]
} {
  if (cachedClusters && Date.now() < cachedClusters.expiresAt) {
    return cachedClusters
  }
  recordModelRun('clustering')
  const cards = loadCardFeatures(db)
  const historyMap = loadAllPriceHistory(db)

  if (cards.length < 10) {
    const empty = { assignments: [] as ClusterAssignment[], profiles: [] as ClusterProfile[], expiresAt: Date.now() + CLUSTERING_TTL }
    cachedClusters = empty
    return empty
  }

  const vecs = buildClusterFeatures(cards, historyMap)
  const rawFeatures = vecs.map(v => v.features)

  const featureDim = rawFeatures[0].length
  const normalizedFeatures: number[][] = []
  for (let d = 0; d < featureDim; d++) {
    const col = rawFeatures.map(r => r[d])
    const normed = normalize(col)
    for (let i = 0; i < rawFeatures.length; i++) {
      if (!normalizedFeatures[i]) normalizedFeatures[i] = []
      normalizedFeatures[i][d] = normed[i]
    }
  }

  let bestK = 5
  let bestScore = -1
  let bestResult = kMeans(normalizedFeatures, 5)

  for (const k of [4, 5, 6]) {
    const result = kMeans(normalizedFeatures, k)
    const score = silhouetteScore(normalizedFeatures, result.assignments, k)
    if (score > bestScore) {
      bestScore = score
      bestK = k
      bestResult = result
    }
  }

  const archetypeMapping = assignArchetypes(bestResult.centroids)

  const assignments: ClusterAssignment[] = vecs.map((v, i) => {
    const clusterId = bestResult.assignments[i]
    const archIdx = archetypeMapping[clusterId] ?? 4
    const template = ARCHETYPE_TEMPLATES[archIdx]

    const centroid = bestResult.centroids[clusterId]
    const dist = Math.sqrt(normalizedFeatures[i].reduce(
      (s, val, d) => s + (val - centroid[d]) ** 2, 0,
    ))
    const confidence = Math.max(0, Math.min(1, 1 - dist / 2))

    return {
      card_id: v.cardId,
      name: v.name,
      cluster_id: clusterId,
      archetype: template.name,
      archetype_color: template.color,
      confidence: Math.round(confidence * 100) / 100,
    }
  })

  const profiles: ClusterProfile[] = []
  for (let c = 0; c < bestK; c++) {
    const members = assignments.filter(a => a.cluster_id === c)
    const memberCards = cards.filter(card => members.some(m => m.card_id === card.id))
    const archIdx = archetypeMapping[c] ?? 4
    const template = ARCHETYPE_TEMPLATES[archIdx]

    const memberVecs = vecs.filter((_, i) => bestResult.assignments[i] === c)

    profiles.push({
      cluster_id: c,
      archetype: template.name,
      archetype_color: template.color,
      description: template.desc,
      card_count: members.length,
      avg_price: Math.round(mean(memberCards.map(c => c.market_price ?? 0)) * 100) / 100,
      avg_volatility: Math.round(mean(memberVecs.map(v => v.features[0])) * 1000) / 1000,
      avg_growth: Math.round(mean(memberVecs.map(v => v.features[1])) * 10000) / 10000,
    })
  }

  cachedClusters = { assignments, profiles, expiresAt: Date.now() + CLUSTERING_TTL }
  return cachedClusters
}

export function getCardCluster(
  db: Database.Database,
  cardId: string,
): (ClusterAssignment & { profile: ClusterProfile }) | { error: string } {
  const clusters = cachedClusters ?? runClustering(db)
  const assignment = clusters.assignments.find(a => a.card_id === cardId)
  if (!assignment) return { error: 'Card not found in clustering results' }

  const profile = clusters.profiles.find(p => p.cluster_id === assignment.cluster_id)
  if (!profile) return { error: 'Cluster profile not found' }

  return { ...assignment, profile }
}

export function getCachedClusters() {
  return cachedClusters
}
