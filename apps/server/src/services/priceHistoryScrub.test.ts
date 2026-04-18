import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { openMemoryDb, seedMinimalCard } from '../test/helpers.js'
import { scrubPriceHistory } from './priceHistoryScrub.js'

function addHistory(
  db: Database.Database,
  cardId: string,
  rows: Array<{ daysAgo: number; market: number | null; pc?: number | null; source?: string | null }>,
) {
  const stmt = db.prepare(
    `INSERT INTO price_history (card_id, timestamp, tcgplayer_market, pricecharting_median, source)
     VALUES (?, ?, ?, ?, ?)`,
  )
  for (const r of rows) {
    const ts = new Date(Date.now() - r.daysAgo * 86_400_000).toISOString()
    stmt.run(cardId, ts, r.market, r.pc ?? null, r.source ?? null)
  }
}

describe('scrubPriceHistory', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb()
    seedMinimalCard(db)
  })

  it('is a no-op on clean history', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ daysAgo: i, market: 100 + i * 0.5 }))
    addHistory(db, 'test-card-1', rows)
    const r = scrubPriceHistory(db)
    expect(r.rowsDeleted).toBe(0)
    expect(r.rowsWinsorized).toBe(0)
  })

  it('deletes a row that triggers all 3 signals (cross-source + MAD + spike-revert)', () => {
    // 14 steady days around $100, then one day at $900 with PC pinning the
    // truth at $100, then back to ~$100. All three signals fire.
    const rows = [
      ...Array.from({ length: 7 }, (_, i) => ({ daysAgo: 14 - i, market: 100, pc: 100 })),
      { daysAgo: 7, market: 900, pc: 100 }, // spike
      ...Array.from({ length: 7 }, (_, i) => ({ daysAgo: 6 - i, market: 100, pc: 100 })),
    ]
    addHistory(db, 'test-card-1', rows)
    const r = scrubPriceHistory(db)
    expect(r.rowsDeleted).toBeGreaterThanOrEqual(1)
    const remaining = db
      .prepare(`SELECT COUNT(*) as c FROM price_history WHERE tcgplayer_market = 900`)
      .get() as { c: number }
    expect(remaining.c).toBe(0)
  })

  it('winsorizes when exactly 2 signals fire (cross-source + MAD, no revert)', () => {
    // 14 days clean @ $100 (pc=100), then a single $900 outlier as the LATEST
    // row. No "after" data means spike-revert can't fire, so we get exactly
    // cross-source + MAD → 2 signals → winsorize (keep row, swap value).
    const rows: Array<{ daysAgo: number; market: number; pc: number }> = []
    for (let i = 14; i >= 1; i--) rows.push({ daysAgo: i, market: 100, pc: 100 })
    rows.push({ daysAgo: 0, market: 900, pc: 100 })
    addHistory(db, 'test-card-1', rows)
    const r = scrubPriceHistory(db)
    expect(r.rowsWinsorized).toBe(1)
    expect(r.rowsDeleted).toBe(0)
    const leftover = db
      .prepare(`SELECT tcgplayer_market FROM price_history WHERE tcgplayer_market = 900`)
      .get()
    expect(leftover).toBeUndefined()
  })

  it('never touches rows tagged source=pricecharting-chart (the anchor)', () => {
    // Even a deranged PC row must be left alone — deleting it would be
    // circular (it's the anchor for other signals).
    const rows = [
      ...Array.from({ length: 7 }, (_, i) => ({ daysAgo: 14 - i, market: 100, pc: 100 })),
      { daysAgo: 7, market: 9999, pc: 9999, source: 'pricecharting-chart' },
      ...Array.from({ length: 7 }, (_, i) => ({ daysAgo: 6 - i, market: 100, pc: 100 })),
    ]
    addHistory(db, 'test-card-1', rows)
    scrubPriceHistory(db)
    const pc = db
      .prepare(`SELECT COUNT(*) as c FROM price_history WHERE source = 'pricecharting-chart'`)
      .get() as { c: number }
    expect(pc.c).toBe(1)
  })

  it('skips cards when too large a fraction of history would be deleted', () => {
    // Two isolated 3-signal spikes in a 14-row history. At the default 25%
    // threshold 2/14≈14% wouldn't trigger the safety net, so we tighten it
    // to 5% for this test. Safety-net then kicks in and deletes NOTHING,
    // protecting against the "reprint looks like a spike" failure mode.
    const rows: Array<{ daysAgo: number; market: number; pc: number }> = []
    for (let i = 14; i >= 0; i--) rows.push({ daysAgo: i, market: 100, pc: 100 })
    // Two separated spikes; each is 100→900→100 so all 3 signals fire.
    rows.find((r) => r.daysAgo === 10)!.market = 900
    rows.find((r) => r.daysAgo === 3)!.market = 900
    addHistory(db, 'test-card-1', rows)
    const r = scrubPriceHistory(db, { maxDeleteFraction: 0.05 })
    expect(r.cardsSkipped).toBe(1)
    expect(r.rowsDeleted).toBe(0)
  })

  it('narrows scope when cardId option is provided', () => {
    db.prepare(
      `INSERT INTO cards (id, name, set_id, rarity, image_url, character_name, card_type, market_price, last_updated)
       VALUES ('other-card', 'Mew', 'test-set', 'Ultra Rare', 'x', 'Mew', 'Ultra Rare', 10, datetime('now'))`,
    ).run()
    addHistory(db, 'test-card-1', [{ daysAgo: 0, market: 100 }])
    addHistory(db, 'other-card', [{ daysAgo: 0, market: 100 }])
    const r = scrubPriceHistory(db, { cardId: 'test-card-1' })
    expect(r.cardsExamined).toBe(1)
  })
})
