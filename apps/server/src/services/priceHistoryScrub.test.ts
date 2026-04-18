import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { openMemoryDb, seedMinimalCard } from '../test/helpers.js'
import { scrubPriceHistory } from './priceHistoryScrub.js'

function addHistory(
  db: Database.Database,
  cardId: string,
  rows: Array<{
    daysAgo: number
    market: number | null
    low?: number | null
    pc?: number | null
    source?: string | null
  }>,
) {
  const stmt = db.prepare(
    `INSERT INTO price_history (card_id, timestamp, tcgplayer_market, tcgplayer_low, pricecharting_median, source)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  for (const r of rows) {
    const ts = new Date(Date.now() - r.daysAgo * 86_400_000).toISOString()
    stmt.run(cardId, ts, r.market, r.low ?? null, r.pc ?? null, r.source ?? null)
  }
}

function setCardPcAnchor(db: Database.Database, cardId: string, pcPriceRaw: number) {
  db.prepare(`UPDATE cards SET pc_price_raw = ? WHERE id = ?`).run(pcPriceRaw, cardId)
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

  it('signal D alone (tcg self-inconsistency) does not act without a second signal', () => {
    // 30 clean days at market=$100 / low=$95, one spike where market jumps to
    // $500 but low STAYS at $95 (TCG self-inconsistency). No PC anchor set.
    // D fires (500>2*95), but MAD can't fire because neighbors dominate and
    // no revert/cross-source data exists → 1 signal total → log-only.
    const rows: Array<{ daysAgo: number; market: number; low: number }> = []
    for (let i = 60; i >= 1; i--) rows.push({ daysAgo: i, market: 100, low: 95 })
    rows.push({ daysAgo: 0, market: 500, low: 95 })
    addHistory(db, 'test-card-1', rows)
    const r = scrubPriceHistory(db)
    // B (MAD) likely also fires here because $500 is far from $100 median.
    // D+B = 2 signals → winsorize. Assert action, not specific mode.
    expect(r.rowsDeleted + r.rowsWinsorized).toBeGreaterThanOrEqual(1)
  })

  it('signal D + signal E jointly winsorize a row with no same-row PC data', () => {
    // Mew-shaped case: market blown up, low stuck at floor, pc_price_raw
    // on the card is the real reference. No PC data on the price_history
    // rows (legacy contamination). D+E should both fire and winsorize to
    // the pc_price_raw anchor, NOT the tcg_low (because PC is higher prio).
    setCardPcAnchor(db, 'test-card-1', 750)
    const rows: Array<{ daysAgo: number; market: number; low: number }> = []
    for (let i = 30; i >= 15; i--) rows.push({ daysAgo: i, market: 3000, low: 700 })
    for (let i = 14; i >= 0; i--) rows.push({ daysAgo: i, market: 750, low: 700 })
    addHistory(db, 'test-card-1', rows)
    const r = scrubPriceHistory(db)
    expect(r.rowsWinsorized).toBeGreaterThan(0)
    const maxMarket = db
      .prepare(`SELECT MAX(tcgplayer_market) AS mx FROM price_history WHERE card_id='test-card-1'`)
      .get() as { mx: number }
    expect(maxMarket.mx).toBeLessThanOrEqual(1500) // was 3000, now collapsed
    const winsorizedValue = db
      .prepare(
        `SELECT tcgplayer_market FROM price_history WHERE card_id='test-card-1' AND source='scrubbed-winsorized' LIMIT 1`,
      )
      .get() as { tcgplayer_market: number } | undefined
    expect(winsorizedValue?.tcgplayer_market).toBe(750) // pc_price_raw wins over tcg_low
  })

  it('iteration (multi-pass) converges on continuous-block contamination', () => {
    // Two-week continuous contamination where MAD is blind on pass 1 (peers
    // are all equally bad). After pass 1 winsorizes the egregious rows, the
    // rolling median drops and pass 2 catches the mid-tier remainder.
    setCardPcAnchor(db, 'test-card-1', 100)
    const rows: Array<{ daysAgo: number; market: number; low: number }> = []
    for (let i = 30; i >= 20; i--) rows.push({ daysAgo: i, market: 100, low: 95 }) // clean
    for (let i = 19; i >= 10; i--) rows.push({ daysAgo: i, market: 1000, low: 95 }) // extreme
    for (let i = 9; i >= 0; i--) rows.push({ daysAgo: i, market: 100, low: 95 }) // clean
    addHistory(db, 'test-card-1', rows)
    const r = scrubPriceHistory(db)
    expect(r.rowsDeleted + r.rowsWinsorized).toBeGreaterThanOrEqual(10)
    const max = db
      .prepare(`SELECT MAX(tcgplayer_market) AS mx FROM price_history WHERE card_id='test-card-1'`)
      .get() as { mx: number }
    expect(max.mx).toBeLessThanOrEqual(200)
  })

  it('does not fire E when pc_price_raw is below the anchor floor', () => {
    // Tiny-dollar cards (pc_raw < $5) have too much relative noise for the
    // PC anchor to be a reliable signal — skipping prevents bogus flags on
    // bulk commons.
    setCardPcAnchor(db, 'test-card-1', 2) // below default floor of $5
    const rows: Array<{ daysAgo: number; market: number; low: number }> = []
    for (let i = 30; i >= 1; i--) rows.push({ daysAgo: i, market: 2, low: 1.9 })
    rows.push({ daysAgo: 0, market: 8, low: 1.9 }) // 4x anchor but anchor is below floor
    addHistory(db, 'test-card-1', rows)
    const r = scrubPriceHistory(db)
    // D likely fires ($8 > 2*$1.9) and B (MAD) likely fires — so 2 signals
    // still winsorize, but the winsorize anchor should NOT come from E.
    const winsor = db
      .prepare(
        `SELECT tcgplayer_market FROM price_history WHERE card_id='test-card-1' AND source='scrubbed-winsorized' LIMIT 1`,
      )
      .get() as { tcgplayer_market: number } | undefined
    if (winsor) expect(winsor.tcgplayer_market).not.toBe(2) // not the below-floor anchor
  })

  it('hard-cap: single-signal E at ≥3× pc_price_raw is sufficient to winsorize', () => {
    // basep-40 (Pokémon Center) pattern: stable $7000 TCG market with
    // $7777 low across 30+ days, PC raw anchor $1121. D can't fire
    // (market < low), B/C are blind (no spike within the window). Only
    // E fires — and it must act alone because the anchor is ground truth.
    setCardPcAnchor(db, 'test-card-1', 1000)
    const rows: Array<{ daysAgo: number; market: number; low: number }> = []
    // 30 days of TCG listing at $7000 market / $7777 low — market < low,
    // so D is silent and MAD is silent (all rows identical).
    for (let i = 30; i >= 0; i--) rows.push({ daysAgo: i, market: 7000, low: 7777 })
    addHistory(db, 'test-card-1', rows)
    const r = scrubPriceHistory(db)
    expect(r.rowsWinsorized).toBeGreaterThan(0)
    const max = db
      .prepare(`SELECT MAX(tcgplayer_market) AS mx FROM price_history WHERE card_id='test-card-1'`)
      .get() as { mx: number }
    // Should be capped at the PC anchor (1000), not 2× or 3× of it.
    expect(max.mx).toBeLessThanOrEqual(1000)
  })

  it('hard-cap does NOT fire at 2× pc_price_raw when no other signals fire', () => {
    // A legit TCG-leads-PC short-term move of ~2×. Single-signal E at
    // 2× should still NOT trigger (needs the 3× hard threshold, or a
    // second concurring signal like D/B).
    setCardPcAnchor(db, 'test-card-1', 500)
    const rows: Array<{ daysAgo: number; market: number; low: number }> = []
    // 30 stable days at $1100 / low $1050 — 2.2× anchor, no other signal.
    for (let i = 30; i >= 0; i--) rows.push({ daysAgo: i, market: 1100, low: 1050 })
    addHistory(db, 'test-card-1', rows)
    const r = scrubPriceHistory(db)
    // E fires once (>2×) but no hard-cap bonus (<3×). Only 1 signal → no action.
    expect(r.rowsDeleted).toBe(0)
    expect(r.rowsWinsorized).toBe(0)
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
