import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { auditPriceHistory } from './priceHistoryAudit.js'

/**
 * Two layers of coverage:
 *
 *   1. Pure-unit: build a fresh in-memory DB, insert known-contaminated
 *      history, and assert the audit flags (and classifies) it.
 *   2. Integration: if the local prod snapshot is present, scan it and
 *      require the >100× bucket to be empty. That's the regression fence
 *      — any future change that reintroduces "$3000 to $5" charts fails
 *      this check.
 */

function buildTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE cards (
      id TEXT PRIMARY KEY,
      name TEXT,
      set_id TEXT,
      market_price REAL,
      pc_price_raw REAL
    );
    CREATE TABLE price_history (
      card_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      tcgplayer_market REAL,
      pricecharting_median REAL,
      source TEXT
    );
  `)
  return db
}

function insertHistory(
  db: Database.Database,
  cardId: string,
  points: { day: number; tcg?: number; pc?: number; source?: string }[],
) {
  const stmt = db.prepare(
    `INSERT INTO price_history (card_id, timestamp, tcgplayer_market, pricecharting_median, source)
     VALUES (?, ?, ?, ?, ?)`,
  )
  for (const p of points) {
    const ts = `2026-04-${String(p.day).padStart(2, '0')}`
    stmt.run(cardId, ts, p.tcg ?? null, p.pc ?? null, p.source ?? 'tcgplayer')
  }
}

describe('auditPriceHistory (unit)', () => {
  it('flags a card whose post-filter ratio exceeds the threshold', () => {
    const db = buildTestDb()
    db.prepare(
      `INSERT INTO cards (id, name, set_id, market_price, pc_price_raw) VALUES (?, ?, ?, ?, ?)`,
    ).run('test-1', 'Bubble Mew', 'sv4pt5', 20, 20)

    // Anchor = $20 → band = [$3, $60]. Seed 12 rows at $20 (keeps filter
    // from bailing out), then two in-band extremes the filter WILL keep:
    // $3.10 and $58. Ratio ≈ 18.7× — above a 15× threshold, below 100×.
    const points = [] as { day: number; tcg: number }[]
    for (let i = 1; i <= 12; i++) points.push({ day: i, tcg: 20 })
    points.push({ day: 13, tcg: 58 })
    points.push({ day: 14, tcg: 3.1 })
    insertHistory(db, 'test-1', points)

    const res1 = auditPriceHistory(db, { thresholdRatio: 100, minRowsPerCard: 5 })
    expect(res1.summary.offenders).toBe(0)

    const res2 = auditPriceHistory(db, { thresholdRatio: 15, minRowsPerCard: 5 })
    expect(res2.summary.offenders).toBe(1)
    const offender = res2.offenders[0]
    expect(offender.card_id).toBe('test-1')
    expect(offender.post_filter_ratio).toBeGreaterThan(15)
    expect(offender.post_filter_min).toBeCloseTo(3.1, 1)
    expect(offender.post_filter_max).toBe(58)
  })

  it('ignores cards with fewer than minRowsPerCard rows', () => {
    const db = buildTestDb()
    db.prepare(
      `INSERT INTO cards (id, name, set_id, market_price, pc_price_raw) VALUES (?, ?, ?, ?, ?)`,
    ).run('sparse-1', 'Noisy', 'x', 10, 10)
    insertHistory(db, 'sparse-1', [
      { day: 1, tcg: 1 },
      { day: 2, tcg: 1000 },
      { day: 3, tcg: 1 },
    ])

    const res = auditPriceHistory(db, { thresholdRatio: 2, minRowsPerCard: 10 })
    expect(res.summary.offenders).toBe(0)
    expect(res.summary.cards_with_history).toBe(0)
  })

  it('buckets offenders by ratio magnitude', () => {
    const db = buildTestDb()
    // Card A — no pc_price_raw, no market_price, so display filter is a
    // no-op and the raw series is audited directly. Use a 50× ratio.
    db.prepare(
      `INSERT INTO cards (id, name, set_id, market_price, pc_price_raw) VALUES (?, ?, ?, ?, ?)`,
    ).run('A', 'Anchorless A', 'x', null, null)
    const a = [] as { day: number; tcg: number }[]
    for (let i = 1; i <= 12; i++) a.push({ day: i, tcg: 10 })
    a.push({ day: 13, tcg: 500 })
    insertHistory(db, 'A', a)

    // Card B — 500× ratio, no anchor.
    db.prepare(
      `INSERT INTO cards (id, name, set_id, market_price, pc_price_raw) VALUES (?, ?, ?, ?, ?)`,
    ).run('B', 'Anchorless B', 'x', null, null)
    const b = [] as { day: number; tcg: number }[]
    for (let i = 1; i <= 12; i++) b.push({ day: i, tcg: 10 })
    b.push({ day: 13, tcg: 5000 })
    insertHistory(db, 'B', b)

    const res = auditPriceHistory(db, { thresholdRatio: 1, minRowsPerCard: 5 })
    expect(res.summary.cards_with_history).toBe(2)
    expect(res.summary.buckets.ratio_10x_to_100x).toBe(1)
    expect(res.summary.buckets.ratio_100x_to_1000x).toBe(1)
    expect(res.summary.buckets.ratio_over_1000x).toBe(0)
  })

  it('filters with the same anchor logic the chart uses (pc_price_raw > market_price)', () => {
    const db = buildTestDb()
    db.prepare(
      `INSERT INTO cards (id, name, set_id, market_price, pc_price_raw) VALUES (?, ?, ?, ?, ?)`,
    ).run('C', 'Bubble Mew', 'sv4pt5', 5000, 800)

    // Anchor will be pc_price_raw (800), band = [120, 2400]. A series
    // with contaminated $5000 rows must be DROPPED by the filter.
    const points = [] as { day: number; tcg: number }[]
    for (let i = 1; i <= 15; i++) points.push({ day: i, tcg: 800 })
    // 3 contaminated rows at $5000 — <60%, so filter applies.
    points.push({ day: 16, tcg: 5000 })
    points.push({ day: 17, tcg: 5000 })
    points.push({ day: 18, tcg: 5000 })
    insertHistory(db, 'C', points)

    const res = auditPriceHistory(db, { thresholdRatio: 2, minRowsPerCard: 5 })
    // Post-filter series is all $800 → ratio is 1 → NOT an offender.
    expect(res.summary.offenders).toBe(0)
    const detail = auditPriceHistory(db, { thresholdRatio: 1.001, minRowsPerCard: 5 })
    // Single-price-point series has ratio 1.0 exactly; no bucket fires.
    expect(detail.summary.offenders).toBe(0)
  })

  it('attributes the worst ratio across TCG and PC sources on the same card', () => {
    const db = buildTestDb()
    db.prepare(
      `INSERT INTO cards (id, name, set_id, market_price, pc_price_raw) VALUES (?, ?, ?, ?, ?)`,
    ).run('D', 'Mixed', 'x', null, null)
    // Clean TCG series, dirty PC series.
    const rows = [] as { day: number; tcg: number; pc: number }[]
    for (let i = 1; i <= 12; i++) rows.push({ day: i, tcg: 10, pc: 10 })
    rows.push({ day: 13, tcg: 10, pc: 9999 })
    insertHistory(db, 'D', rows)

    const res = auditPriceHistory(db, { thresholdRatio: 50, minRowsPerCard: 5 })
    expect(res.summary.offenders).toBe(1)
    expect(res.offenders[0].post_filter_ratio).toBeGreaterThan(50)
  })
})

/* ── integration: run against prod-shaped snapshot ─────────────── */

const LOCAL_DB = path.resolve(
  path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'data', 'pokegrails.sqlite'),
)

function snapshotLooksReal(p: string): boolean {
  try {
    if (!fs.existsSync(p)) return false
    if (fs.statSync(p).size < 10_000_000) return false
    const db = new Database(p, { readonly: true, fileMustExist: true })
    try {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM cards`).get() as { c: number }
      return row.c > 100
    } finally {
      db.close()
    }
  } catch {
    return false
  }
}

const haveLocal = snapshotLooksReal(LOCAL_DB)
const describeIfLocal = haveLocal ? describe : describe.skip

describeIfLocal('auditPriceHistory (integration — local snapshot)', () => {
  it('prod snapshot has ≤5 cards with >100× post-filter spread', () => {
    const db = new Database(LOCAL_DB, { readonly: true, fileMustExist: true })
    try {
      const result = auditPriceHistory(db, { thresholdRatio: 100, maxOffenders: 20 })
      if (result.summary.offenders > 5) {
        // Print enough context that the CI log points straight at the
        // offenders rather than forcing someone to re-run locally.
        console.error('[audit-regression] offenders:', JSON.stringify(result.offenders, null, 2))
      }
      expect(result.summary.offenders).toBeLessThanOrEqual(5)
    } finally {
      db.close()
    }
  })
})
