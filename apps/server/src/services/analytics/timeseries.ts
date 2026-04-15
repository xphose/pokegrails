import type Database from 'better-sqlite3'
import {
  loadPriceHistory, mean, stddev, linearRegression, recordModelRun,
  type PricePoint,
} from './shared.js'

export type TimeSeriesForecast = {
  historical: { date: string; price: number }[]
  forecast: { date: string; price: number }[]
  confidence_upper: { date: string; price: number }[]
  confidence_lower: { date: string; price: number }[]
  model_used: 'exponential_smoothing' | 'linear_trend'
  seasonality_detected: boolean
  seasonality_windows: { label: string; month: number }[]
}

const SEASON_WINDOWS = [
  { label: 'Holiday spike', month: 11 },
  { label: 'Holiday spike', month: 12 },
  { label: 'Championship season', month: 5 },
  { label: 'Championship season', month: 6 },
  { label: 'Championship season', month: 7 },
  { label: 'Championship season', month: 8 },
]

function detectSeasonality(points: PricePoint[]): { detected: boolean; windows: typeof SEASON_WINDOWS } {
  if (points.length < 60) return { detected: false, windows: [] }

  const byMonth = new Map<number, number[]>()
  for (const p of points) {
    const m = new Date(p.timestamp).getMonth() + 1
    const arr = byMonth.get(m) ?? []
    arr.push(p.price)
    byMonth.set(m, arr)
  }

  const monthAvgs = new Map<number, number>()
  for (const [m, prices] of byMonth) {
    monthAvgs.set(m, mean(prices))
  }

  const overallMean = mean(points.map(p => p.price))
  if (overallMean === 0) return { detected: false, windows: [] }

  const hitMonths = SEASON_WINDOWS.filter(w => {
    const avg = monthAvgs.get(w.month)
    return avg != null && avg > overallMean * 1.08
  })

  return { detected: hitMonths.length >= 2, windows: hitMonths }
}

function exponentialSmoothing(prices: number[], alpha = 0.3, beta = 0.1, horizon: number): number[] {
  if (prices.length < 2) return Array(horizon).fill(prices[0] ?? 0)

  let level = prices[0]
  let trend = prices[1] - prices[0]

  for (let i = 1; i < prices.length; i++) {
    const prevLevel = level
    level = alpha * prices[i] + (1 - alpha) * (level + trend)
    trend = beta * (level - prevLevel) + (1 - beta) * trend
  }

  const forecast: number[] = []
  for (let h = 1; h <= horizon; h++) {
    forecast.push(Math.max(0.01, level + trend * h))
  }
  return forecast
}

export function forecastTimeSeries(
  db: Database.Database,
  cardId: string,
  horizon = 30,
): TimeSeriesForecast | { error: string } {
  const history = loadPriceHistory(db, cardId)
  if (history.length < 5) {
    return { error: `Insufficient data: ${history.length} daily price points (need 5+). Check back after more price snapshots.` }
  }

  recordModelRun('timeseries')

  const prices = history.map(h => h.price)
  const { detected: seasonality_detected, windows } = detectSeasonality(history)

  let forecastPrices: number[]
  let model_used: TimeSeriesForecast['model_used']

  if (history.length >= 30) {
    forecastPrices = exponentialSmoothing(prices, 0.3, 0.1, horizon)
    model_used = 'exponential_smoothing'
  } else {
    const xVals = prices.map((_, i) => i)
    const reg = linearRegression(xVals, prices)
    forecastPrices = []
    for (let h = 1; h <= horizon; h++) {
      forecastPrices.push(Math.max(0.01, reg.intercept + reg.slope * (prices.length + h)))
    }
    model_used = 'linear_trend'
  }

  const residuals = prices.slice(-Math.min(30, prices.length))
  const residStd = stddev(residuals) || mean(residuals) * 0.1
  const confidenceScale = model_used === 'exponential_smoothing' ? 1.0 : 1.5

  const lastDate = new Date(history[history.length - 1].timestamp)
  const forecastDates = forecastPrices.map((_, i) => {
    const d = new Date(lastDate)
    d.setDate(d.getDate() + i + 1)
    return d.toISOString().split('T')[0]
  })

  return {
    historical: history.map(h => ({ date: h.timestamp.split('T')[0], price: h.price })),
    forecast: forecastPrices.map((p, i) => ({ date: forecastDates[i], price: Math.round(p * 100) / 100 })),
    confidence_upper: forecastPrices.map((p, i) => ({
      date: forecastDates[i],
      price: Math.round((p + residStd * confidenceScale * Math.sqrt(i + 1)) * 100) / 100,
    })),
    confidence_lower: forecastPrices.map((p, i) => ({
      date: forecastDates[i],
      price: Math.max(0.01, Math.round((p - residStd * confidenceScale * Math.sqrt(i + 1)) * 100) / 100),
    })),
    model_used,
    seasonality_detected,
    seasonality_windows: windows,
  }
}
