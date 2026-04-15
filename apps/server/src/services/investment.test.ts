import { describe, it, expect } from 'vitest'
import { buildNegotiation } from './investment.js'

describe('buildNegotiation', () => {
  it('opening < ideal < max < anchor for a typical card', () => {
    const { opening_offer, ideal_price, max_pay } = buildNegotiation(50, 0, 50)
    expect(opening_offer).toBeLessThan(ideal_price)
    expect(ideal_price).toBeLessThan(max_pay)
    expect(max_pay).toBeLessThanOrEqual(50)
  })

  it('anchors on the higher of fairValue and marketPrice', () => {
    const undervalued = buildNegotiation(100, 0, 60)
    const overvalued = buildNegotiation(60, 0, 100)
    expect(undervalued.max_pay).toBeCloseTo(100 * 0.93, 1)
    expect(overvalued.max_pay).toBeCloseTo(100 * 0.93, 1)
  })

  it('falls back to fairValue when marketPrice is null', () => {
    const result = buildNegotiation(80, 0, null)
    expect(result.max_pay).toBeCloseTo(80 * 0.93, 1)
  })

  it('falls back to fairValue when marketPrice is 0', () => {
    const result = buildNegotiation(80, 0, 0)
    expect(result.max_pay).toBeCloseTo(80 * 0.93, 1)
  })

  it('widens bands for expensive cards (>$500)', () => {
    const cheap = buildNegotiation(50, 0, 50)
    const expensive = buildNegotiation(800, 0, 800)

    const cheapPct = cheap.opening_offer / 50
    const expPct = expensive.opening_offer / 800
    expect(expPct).toBeLessThan(cheapPct)
  })

  it('negative sentiment raises opening (less aggressive discount)', () => {
    const neutral = buildNegotiation(100, 0, 100)
    const negative = buildNegotiation(100, -0.3, 100)
    expect(negative.opening_offer).toBeGreaterThan(neutral.opening_offer)
  })

  it('strong positive sentiment lowers opening (more aggressive discount)', () => {
    const neutral = buildNegotiation(100, 0, 100)
    const positive = buildNegotiation(100, 0.5, 100)
    expect(positive.opening_offer).toBeLessThan(neutral.opening_offer)
  })

  it('all prices are positive and finite', () => {
    const edgeCases = [
      [1, 0, 1],
      [0.01, 0, 0.01],
      [10000, -1, 8000],
      [100, 0.5, null],
    ] as const

    for (const [fair, sent, market] of edgeCases) {
      const r = buildNegotiation(fair, sent, market as number | null)
      expect(r.opening_offer).toBeGreaterThanOrEqual(0)
      expect(Number.isFinite(r.opening_offer)).toBe(true)
      expect(Number.isFinite(r.ideal_price)).toBe(true)
      expect(Number.isFinite(r.max_pay)).toBe(true)
    }
  })

  it('max_pay never exceeds anchor price', () => {
    for (const anchor of [10, 50, 100, 500, 1000, 5000]) {
      const r = buildNegotiation(anchor, 0, anchor)
      expect(r.max_pay).toBeLessThanOrEqual(anchor)
    }
  })

  it('returns a walk_away_script string', () => {
    const r = buildNegotiation(100, 0, 100)
    expect(typeof r.walk_away_script).toBe('string')
    expect(r.walk_away_script.length).toBeGreaterThan(0)
  })
})
