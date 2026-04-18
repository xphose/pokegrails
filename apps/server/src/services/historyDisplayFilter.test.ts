import { describe, it, expect } from 'vitest'
import { applyHistoryDisplayFilter } from './historyDisplayFilter.js'

const pt = (price: number) => ({ timestamp: '2026-01-01', price, source: 'tcg' })

describe('applyHistoryDisplayFilter', () => {
  it('returns raw series untouched when no anchor', () => {
    const rows = [pt(5), pt(10), pt(99999), pt(0.01)]
    const { series, filtered } = applyHistoryDisplayFilter(rows, null)
    expect(series).toEqual(rows)
    expect(filtered).toBe(0)
  })

  it('returns empty unchanged', () => {
    expect(applyHistoryDisplayFilter([], 50)).toEqual({ series: [], filtered: 0 })
  })

  it('drops rows above anchor × 3', () => {
    // anchor = 5. Cap = 15. $3000 row must go.
    const rows = [pt(5), pt(8), pt(3000)]
    const { series, filtered } = applyHistoryDisplayFilter(rows, 5)
    expect(series.map((r) => r.price)).toEqual([5, 8])
    expect(filtered).toBe(1)
  })

  it('drops rows below anchor × 0.15 (cents-bug catcher)', () => {
    // anchor = 5. Floor = 0.75. $0.01 row must go.
    const rows = [pt(5), pt(4), pt(0.01)]
    const { series, filtered } = applyHistoryDisplayFilter(rows, 5)
    expect(series.map((r) => r.price)).toEqual([5, 4])
    expect(filtered).toBe(1)
  })

  it('keeps legitimate 2× moves (real pumps, not contamination)', () => {
    // anchor = $100. A series that goes from $50 to $200 is believable.
    const rows = [pt(50), pt(75), pt(100), pt(150), pt(200)]
    const { series, filtered } = applyHistoryDisplayFilter(rows, 100)
    expect(series.map((r) => r.price)).toEqual([50, 75, 100, 150, 200])
    expect(filtered).toBe(0)
  })

  it('bails out (returns raw) when filter would drop > 60% of rows', () => {
    // Anchor is wrong / stale — the "contamination" is actually the real
    // price. Don't hide 70% of the chart.
    const rows = [pt(100), pt(100), pt(100), pt(100), pt(100), pt(100), pt(100), pt(5)]
    // Anchor $5 → band [$0.75, $15]. Seven rows at $100 would be dropped → 87.5% reject.
    const { series, filtered } = applyHistoryDisplayFilter(rows, 5)
    expect(series.length).toBe(8) // all returned
    expect(filtered).toBe(0)
  })

  it('drops zero and negative-price rows regardless of anchor', () => {
    const rows = [pt(10), pt(0), pt(-5), pt(12)]
    const { series, filtered } = applyHistoryDisplayFilter(rows, 10)
    expect(series.map((r) => r.price)).toEqual([10, 12])
    expect(filtered).toBe(2)
  })

  it('ignores anchor when anchor itself is <= 0 or NaN', () => {
    const rows = [pt(5), pt(3000)]
    expect(applyHistoryDisplayFilter(rows, 0).series.length).toBe(2)
    expect(applyHistoryDisplayFilter(rows, -1).series.length).toBe(2)
    expect(applyHistoryDisplayFilter(rows, NaN).series.length).toBe(2)
  })

  it('regression: Pikachu VMAX shape (anchor=5, 198 normal + 21 bad)', () => {
    // Reproduces swshp-SWSH286 post-scrub distribution: 198 rows in the
    // $4-$8 range plus 21 rows at $3000+. Display filter must keep the
    // normal rows and drop the 21 outliers.
    const rows: ReturnType<typeof pt>[] = []
    for (let i = 0; i < 198; i++) rows.push(pt(4 + Math.random() * 4))
    for (let i = 0; i < 21; i++) rows.push(pt(3000 + Math.random() * 500))

    const { series, filtered } = applyHistoryDisplayFilter(rows, 5)
    expect(series.length).toBe(198)
    expect(filtered).toBe(21)
    // And critically: no kept row can be over 3× the anchor.
    for (const r of series) expect(r.price).toBeLessThanOrEqual(15)
  })

  it('regression: Mew ex bubble shape (anchor=748.75, some $1399 rows)', () => {
    // Anchor $748.75 → band [$112.31, $2246.25]. $1399 rows stay (1.87×
    // the anchor — legitimate TCG-leads-PC delta). A bogus $4000 row goes.
    const rows = [pt(748.75), pt(1399), pt(1399), pt(3987), pt(629.99)]
    const { series, filtered } = applyHistoryDisplayFilter(rows, 748.75)
    expect(series.map((r) => r.price)).toEqual([748.75, 1399, 1399, 629.99])
    expect(filtered).toBe(1)
  })
})
