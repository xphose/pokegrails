import type Database from 'better-sqlite3'
import { loadCardFeatures, extractFeatureVector, mean, normalize, recordModelRun } from './shared.js'

export type PCAComponent = {
  component_id: number
  label: string
  explained_variance: number
  cumulative_variance: number
  top_features: { name: string; loading: number }[]
}

export type PCAResult = {
  components: PCAComponent[]
  total_variance_explained: number
  card_count: number
  feature_count: number
  computed_at: string
}

function covarianceMatrix(data: number[][]): number[][] {
  const n = data.length
  const dim = data[0]?.length ?? 0
  if (n === 0 || dim === 0) return []

  const means = new Array(dim).fill(0)
  for (let d = 0; d < dim; d++) {
    for (let i = 0; i < n; i++) means[d] += data[i][d]
    means[d] /= n
  }

  const cov: number[][] = Array.from({ length: dim }, () => new Array(dim).fill(0))
  for (let i = 0; i < dim; i++) {
    for (let j = i; j < dim; j++) {
      let s = 0
      for (let k = 0; k < n; k++) {
        s += (data[k][i] - means[i]) * (data[k][j] - means[j])
      }
      cov[i][j] = s / (n - 1)
      cov[j][i] = cov[i][j]
    }
  }
  return cov
}

function powerIteration(
  matrix: number[][],
  dim: number,
  numComponents: number,
  maxIter = 100,
): { eigenvalues: number[]; eigenvectors: number[][] } {
  const eigenvalues: number[] = []
  const eigenvectors: number[][] = []
  const mat = matrix.map(row => [...row])

  for (let comp = 0; comp < numComponents; comp++) {
    let vec = new Array(dim).fill(0)
    vec[comp % dim] = 1
    for (let d = 0; d < dim; d++) vec[d] += Math.random() * 0.01

    let eigenvalue = 0

    for (let iter = 0; iter < maxIter; iter++) {
      const newVec = new Array(dim).fill(0)
      for (let i = 0; i < dim; i++) {
        for (let j = 0; j < dim; j++) {
          newVec[i] += mat[i][j] * vec[j]
        }
      }

      const norm = Math.sqrt(newVec.reduce((s, v) => s + v * v, 0))
      if (norm === 0) break
      for (let i = 0; i < dim; i++) newVec[i] /= norm

      eigenvalue = 0
      for (let i = 0; i < dim; i++) {
        let mv = 0
        for (let j = 0; j < dim; j++) mv += mat[i][j] * newVec[j]
        eigenvalue += newVec[i] * mv
      }

      const diff = vec.reduce((s, v, i) => s + (v - newVec[i]) ** 2, 0)
      vec = newVec
      if (diff < 1e-10) break
    }

    eigenvalues.push(eigenvalue)
    eigenvectors.push(vec)

    for (let i = 0; i < dim; i++) {
      for (let j = 0; j < dim; j++) {
        mat[i][j] -= eigenvalue * vec[i] * vec[j]
      }
    }
  }

  return { eigenvalues, eigenvectors }
}

let cachedResult: PCAResult | null = null

export function computePCA(db: Database.Database): PCAResult {
  recordModelRun('pca')
  const cards = loadCardFeatures(db)

  if (cards.length < 10) {
    return {
      components: [],
      total_variance_explained: 0,
      card_count: cards.length,
      feature_count: 0,
      computed_at: new Date().toISOString(),
    }
  }

  const allFeatures: number[][] = []
  let labels: string[] = []

  for (const c of cards) {
    const { labels: l, values } = extractFeatureVector(c)
    labels = l
    allFeatures.push(values)
  }

  const dim = labels.length
  const normalizedFeatures: number[][] = Array.from({ length: allFeatures.length }, () => new Array(dim).fill(0))
  for (let d = 0; d < dim; d++) {
    const col = allFeatures.map(r => r[d])
    const normed = normalize(col)
    for (let i = 0; i < allFeatures.length; i++) {
      normalizedFeatures[i][d] = normed[i]
    }
  }

  const cov = covarianceMatrix(normalizedFeatures)
  const numComponents = Math.min(dim, 6)
  const { eigenvalues, eigenvectors } = powerIteration(cov, dim, numComponents)

  const totalVariance = eigenvalues.reduce((s, v) => s + Math.max(0, v), 0) || 1
  let cumulative = 0

  const components: PCAComponent[] = eigenvalues.map((ev, idx) => {
    const explained = Math.max(0, ev) / totalVariance
    cumulative += explained

    const loadings = eigenvectors[idx].map((loading, fIdx) => ({
      name: labels[fIdx],
      loading: Math.round(Math.abs(loading) * 10000) / 10000,
    })).sort((a, b) => b.loading - a.loading)

    const topFeature = loadings[0]?.name ?? 'mixed'
    const label = `PC${idx + 1}: ${topFeature}-driven`

    return {
      component_id: idx + 1,
      label,
      explained_variance: Math.round(explained * 10000) / 10000,
      cumulative_variance: Math.round(cumulative * 10000) / 10000,
      top_features: loadings.slice(0, 4),
    }
  })

  cachedResult = {
    components,
    total_variance_explained: Math.round(cumulative * 10000) / 10000,
    card_count: cards.length,
    feature_count: dim,
    computed_at: new Date().toISOString(),
  }
  return cachedResult
}

export function getCachedPCA(): PCAResult | null {
  return cachedResult
}
