import { describe, expect, it } from 'vitest'
import {
  detectCardType,
  gateMarketPrice,
  normalizeRarityTier,
  parseCharacterName,
  printBucket,
  recentMedianAndMad,
  type TcgPriceEnvelope,
} from './pokemontcg.js'
import { openMemoryDb, seedMinimalCard } from '../test/helpers.js'

describe('pokemontcg helpers', () => {
  it('parseCharacterName uses Pokémon after trainer possessive (Team Rocket)', () => {
    expect(parseCharacterName('Charizard ex')).toBe('Charizard')
    expect(parseCharacterName("Team Rocket's Mewtwo ex")).toBe('Mewtwo')
    expect(parseCharacterName("Team Rocket's Crobat ex")).toBe('Crobat')
  })

  it('parseCharacterName strips regional prefixes', () => {
    expect(parseCharacterName('Alolan Vulpix')).toBe('Vulpix')
  })

  it('normalizeRarityTier maps illustration tiers', () => {
    expect(normalizeRarityTier('Special Illustration Rare')).toBe('Special Illustration Rare')
    expect(normalizeRarityTier('Illustration Rare')).toBe('Illustration Rare')
    expect(normalizeRarityTier('Ultra Rare')).toBe('Ultra Rare')
  })

  it('detectCardType returns SIR and Hyper Rare', () => {
    expect(detectCardType('Special Illustration Rare')).toBe('SIR')
    expect(detectCardType('Ultra Rare')).toBe('Ultra Rare')
    expect(detectCardType('Hyper Rare')).toBe('Hyper Rare')
    expect(detectCardType('Double Rare')).toBe('Double Rare')
  })

  it('printBucket matches detectCardType', () => {
    expect(printBucket('Special Illustration Rare')).toBe('SIR')
  })
})

const env = (patch: Partial<TcgPriceEnvelope> = {}): TcgPriceEnvelope => ({
  market: null,
  low: null,
  mid: null,
  high: null,
  updatedAt: null,
  variant: null,
  ...patch,
})

describe('gateMarketPrice', () => {
  it('passes through a reasonable price', () => {
    const r = gateMarketPrice(env({ market: 12, mid: 11 }), 11.5, null)
    expect(r.market).toBe(12)
    expect(r.reason).toBe('pass')
  })

  it('falls back to mid when market is >3x mid (TCGPlayer envelope disagrees)', () => {
    // Mimics the Bubble Mew situation: mid=$600 is sane, market=$3987 came
    // from one whale sale dominating the volume-weighted average.
    const r = gateMarketPrice(env({ market: 3987, mid: 600 }), 620, null)
    expect(r.market).toBe(600)
    // reason may be high_vs_mid OR spike_vs_prior depending on which fires
    // first; both are legitimate rejections. The VALUE is what matters.
  })

  it('rejects a >5x spike vs prior ingest and keeps the old price', () => {
    const r = gateMarketPrice(env({ market: 1000, mid: 1000 }), 100, null)
    expect(r.market).toBe(100)
    expect(r.reason).toBe('spike_vs_prior')
  })

  it('winsorizes a 3-5x move rather than dropping it', () => {
    const r = gateMarketPrice(env({ market: 400, mid: 400 }), 100, null)
    expect(r.market).toBe(300) // capped at 3x prior
    expect(r.reason).toBe('winsorized')
  })

  it('rejects outliers more than 5 MADs from a rolling median', () => {
    const r = gateMarketPrice(
      env({ market: 500, mid: 500 }),
      null,
      { median: 50, mad: 5, count: 10 },
    )
    // 5 MADs of 5 = 25 → anything beyond $25 from $50 is out. 500 fails hard.
    expect(r.reason).toBe('mad_outlier')
    expect(r.market).toBe(50) // anchor back to median
  })

  it('accepts values within the MAD envelope even if noisy', () => {
    const r = gateMarketPrice(
      env({ market: 65, mid: 65 }),
      60,
      { median: 50, mad: 5, count: 10 },
    )
    expect(r.market).toBe(65)
    expect(r.reason).toBe('pass')
  })

  it('returns null_input when nothing usable is present', () => {
    const r = gateMarketPrice(env(), null, null)
    expect(r.market).toBeNull()
    expect(r.reason).toBe('null_input')
  })

  it('does not spike-reject when there is no meaningful prior (<=$10)', () => {
    // Low-priced cards naturally have large relative swings; the spike gate
    // ignores prior < $10 to avoid over-suppressing them.
    const r = gateMarketPrice(env({ market: 80, mid: 80 }), 5, null)
    expect(r.market).toBe(80)
    expect(r.reason).toBe('pass')
  })
})

describe('recentMedianAndMad', () => {
  it('returns null when fewer than 3 samples exist', () => {
    const db = openMemoryDb()
    seedMinimalCard(db)
    const row = (ts: string, p: number) => db.prepare(
      `INSERT INTO price_history (card_id, timestamp, tcgplayer_market) VALUES (?, ?, ?)`,
    ).run('test-card-1', ts, p)
    row(new Date().toISOString(), 10)
    row(new Date(Date.now() - 86400_000).toISOString(), 11)
    expect(recentMedianAndMad(db, 'test-card-1')).toBeNull()
  })

  it('computes median + MAD over the window', () => {
    const db = openMemoryDb()
    seedMinimalCard(db)
    const add = (daysAgo: number, p: number) => db.prepare(
      `INSERT INTO price_history (card_id, timestamp, tcgplayer_market) VALUES (?, ?, ?)`,
    ).run('test-card-1', new Date(Date.now() - daysAgo * 86_400_000).toISOString(), p)
    for (let i = 0; i < 7; i++) add(i, 100 + i) // 100..106
    const stats = recentMedianAndMad(db, 'test-card-1', 14)
    expect(stats).not.toBeNull()
    expect(stats!.count).toBe(7)
    expect(stats!.median).toBe(103)
    // MAD of {100..106} around 103 is 2
    expect(stats!.mad).toBe(2)
  })

  it('ignores rows outside the window', () => {
    const db = openMemoryDb()
    seedMinimalCard(db)
    const add = (daysAgo: number, p: number) => db.prepare(
      `INSERT INTO price_history (card_id, timestamp, tcgplayer_market) VALUES (?, ?, ?)`,
    ).run('test-card-1', new Date(Date.now() - daysAgo * 86_400_000).toISOString(), p)
    add(30, 9999) // outside 14-day window
    for (let i = 0; i < 5; i++) add(i, 50 + i)
    const stats = recentMedianAndMad(db, 'test-card-1', 14)
    expect(stats!.count).toBe(5)
    expect(stats!.median).toBeLessThan(100)
  })
})
