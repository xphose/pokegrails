import { describe, it, expect, beforeEach } from 'vitest'
import {
  rarityToNumeric,
  mean, stddev, median, normalize, zScore,
  pearsonCorrelation, linearRegression,
  startRun, updateRunProgress, completeRunStep, finishRun,
  getRunProgress, isRunning,
} from './shared.js'

/* ── rarityToNumeric ──────────────────────────────────────────── */

describe('rarityToNumeric', () => {
  it('separates Special Illustration Rare from Hyper Rare', () => {
    expect(rarityToNumeric('Special Illustration Rare')).toBe(11)
    expect(rarityToNumeric('Hyper Rare')).toBe(10)
    expect(rarityToNumeric('Special Illustration Rare'))
      .toBeGreaterThan(rarityToNumeric('Hyper Rare'))
  })

  it('maps all standard rarity tiers in descending order', () => {
    const tiers = [
      ['Special Illustration Rare', 11],
      ['Hyper Rare', 10],
      ['Rare Rainbow', 9],
      ['Rare Secret', 9],
      ['Shiny Ultra Rare', 9],
      ['Illustration Rare', 8],
      ['Alternate Art', 8],
      ['Full Art', 7],
      ['Ultra Rare', 6],
      ['Rare Ultra', 6],
      ['VMAX', 5],
      ['VSTAR', 5],
      ['Double Rare', 5],
      ['Rare Holo', 4],
      ['Holo Rare', 4],
      ['Shiny Rare', 4],
      ['Trainer Gallery', 4],
      ['Radiant', 4],
      ['Classic Collection', 4],
      ['Rare', 3],
      ['Uncommon', 2],
      ['Common', 1],
    ] as const

    for (const [rarity, expected] of tiers) {
      expect(rarityToNumeric(rarity)).toBe(expected)
    }
  })

  it('is case-insensitive', () => {
    expect(rarityToNumeric('special illustration rare')).toBe(11)
    expect(rarityToNumeric('HYPER RARE')).toBe(10)
    expect(rarityToNumeric('ultra rare')).toBe(6)
  })

  it('returns 3 for null or unrecognized', () => {
    expect(rarityToNumeric(null)).toBe(3)
    expect(rarityToNumeric('')).toBe(3)
    expect(rarityToNumeric('Mystery Rarity')).toBe(3)
  })

  it('does not match "Rare" prefix for rarer tiers', () => {
    expect(rarityToNumeric('Rare Rainbow')).toBe(9)
    expect(rarityToNumeric('Rare Holo')).toBe(4)
    expect(rarityToNumeric('Rare')).toBe(3)
  })
})

/* ── Math utilities ───────────────────────────────────────────── */

describe('mean', () => {
  it('returns 0 for empty array', () => expect(mean([])).toBe(0))
  it('computes average', () => expect(mean([2, 4, 6])).toBe(4))
  it('handles single element', () => expect(mean([7])).toBe(7))
})

describe('stddev', () => {
  it('returns 0 for single element', () => expect(stddev([5])).toBe(0))
  it('returns 0 for empty array', () => expect(stddev([])).toBe(0))
  it('computes sample stddev', () => {
    const sd = stddev([2, 4, 4, 4, 5, 5, 7, 9])
    expect(sd).toBeGreaterThan(1)
    expect(sd).toBeLessThan(3)
  })
})

describe('median', () => {
  it('returns 0 for empty', () => expect(median([])).toBe(0))
  it('returns middle for odd', () => expect(median([3, 1, 2])).toBe(2))
  it('returns average of two middles for even', () => expect(median([1, 2, 3, 4])).toBe(2.5))
})

describe('normalize', () => {
  it('maps to [0,1]', () => {
    const result = normalize([10, 20, 30])
    expect(result[0]).toBe(0)
    expect(result[2]).toBe(1)
    expect(result[1]).toBeCloseTo(0.5)
  })
  it('returns all zeros when values are equal', () => {
    expect(normalize([5, 5, 5])).toEqual([0, 0, 0])
  })
})

describe('zScore', () => {
  it('returns 0 when stddev is 0', () => expect(zScore(10, 5, 0)).toBe(0))
  it('computes correct z value', () => expect(zScore(12, 10, 2)).toBe(1))
  it('handles negative z', () => expect(zScore(8, 10, 2)).toBe(-1))
})

describe('pearsonCorrelation', () => {
  it('returns 0 for fewer than 3 points', () => {
    expect(pearsonCorrelation([1, 2], [2, 4])).toBe(0)
  })
  it('returns ~1 for perfectly correlated data', () => {
    expect(pearsonCorrelation([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 5)
  })
  it('returns ~-1 for perfectly inverse data', () => {
    expect(pearsonCorrelation([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 5)
  })
  it('handles mismatched lengths by using shorter', () => {
    const r = pearsonCorrelation([1, 2, 3, 4, 5], [2, 4, 6])
    expect(Math.abs(r)).toBeCloseTo(1, 5)
  })
})

describe('linearRegression', () => {
  it('returns zero slope for single point', () => {
    const r = linearRegression([1], [5])
    expect(r.slope).toBe(0)
    expect(r.rSquared).toBe(0)
  })
  it('fits perfect line', () => {
    const r = linearRegression([1, 2, 3, 4], [3, 5, 7, 9])
    expect(r.slope).toBeCloseTo(2, 5)
    expect(r.intercept).toBeCloseTo(1, 5)
    expect(r.rSquared).toBeCloseTo(1, 5)
  })
})

/* ── Run progress state machine ───────────────────────────────── */

describe('Run progress state machine', () => {
  beforeEach(() => {
    if (isRunning()) finishRun()
  })

  it('starts in idle state', () => {
    const p = getRunProgress()
    expect(p.running).toBe(false)
    expect(p.current_model).toBeNull()
    expect(p.completed).toEqual([])
    expect(p.queued).toEqual([])
    expect(p.total).toBe(0)
  })

  it('startRun transitions to running', () => {
    expect(startRun(3, ['a', 'b', 'c'])).toBe(true)
    const p = getRunProgress()
    expect(p.running).toBe(true)
    expect(p.total).toBe(3)
    expect(p.queued).toEqual(['a', 'b', 'c'])
    expect(p.started_at).toBeTruthy()
    expect(p.elapsed_ms).toBeGreaterThanOrEqual(0)
    expect(p.finished_at).toBeNull()
    finishRun()
  })

  it('rejects duplicate startRun', () => {
    startRun(2, ['a', 'b'])
    expect(startRun(1, ['c'])).toBe(false)
    expect(isRunning()).toBe(true)
    finishRun()
  })

  it('updateRunProgress moves model from queued to current', () => {
    startRun(2, ['a', 'b'])
    updateRunProgress('a')
    const p = getRunProgress()
    expect(p.current_model).toBe('a')
    expect(p.queued).toEqual(['b'])
    finishRun()
  })

  it('completeRunStep records duration and clears current', () => {
    startRun(2, ['a', 'b'])
    updateRunProgress('a')
    completeRunStep('a')
    const p = getRunProgress()
    expect(p.current_model).toBeNull()
    expect(p.completed).toHaveLength(1)
    expect(p.completed[0].id).toBe('a')
    expect(p.completed[0].duration_ms).toBeGreaterThanOrEqual(0)
    finishRun()
  })

  it('full lifecycle: start → update → complete → finish', () => {
    startRun(2, ['x', 'y'])

    updateRunProgress('x')
    expect(getRunProgress().queued).toEqual(['y'])

    completeRunStep('x')
    expect(getRunProgress().completed).toHaveLength(1)

    updateRunProgress('y')
    expect(getRunProgress().queued).toEqual([])

    completeRunStep('y')
    expect(getRunProgress().completed).toHaveLength(2)

    finishRun()
    const final = getRunProgress()
    expect(final.running).toBe(false)
    expect(final.finished_at).toBeTruthy()
    expect(final.queued).toEqual([])
  })

  it('finishRun with error preserves error message', () => {
    startRun(1, ['a'])
    finishRun('Something broke')
    const p = getRunProgress()
    expect(p.running).toBe(false)
    expect(p.error).toBe('Something broke')
  })

  it('getRunProgress returns copies not references', () => {
    startRun(1, ['a'])
    updateRunProgress('a')
    completeRunStep('a')
    const p1 = getRunProgress()
    const p2 = getRunProgress()
    expect(p1.completed).not.toBe(p2.completed)
    expect(p1.queued).not.toBe(p2.queued)
    finishRun()
  })
})
