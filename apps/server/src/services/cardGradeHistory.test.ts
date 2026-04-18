import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { createApp } from '../app.js'
import { openMemoryDb, seedMinimalCard } from '../test/helpers.js'
import { cacheInvalidateAll } from '../cache.js'

const isoDay = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString().split('T')[0] + 'T00:00:00.000Z'

describe('GET /api/cards/:id/history?grade=...', () => {
  it('defaults to raw and unions TCGPlayer + PC grade-history rows', async () => {
    const db = openMemoryDb()
    cacheInvalidateAll()
    seedMinimalCard(db)
    db.prepare(
      `INSERT INTO price_history (card_id, timestamp, tcgplayer_market) VALUES (?, ?, ?)`,
    ).run('test-card-1', isoDay(2), 10)
    db.prepare(
      `INSERT INTO card_grade_history (card_id, grade, ts, price) VALUES (?, ?, ?, ?)`,
    ).run('test-card-1', 'raw', isoDay(1), 11)

    const r = await request(createApp(db)).get('/api/cards/test-card-1/history')
    expect(r.status).toBe(200)
    expect(r.body.grade).toBe('raw')
    expect(r.body.pointInTime).toBe(false)
    expect(r.body.series.length).toBe(2)
    expect(r.body.series[0].price).toBe(10) // older first
    expect(r.body.series[1].price).toBe(11)
  })

  it('prefers pricecharting-grade over tcgplayer on same-day collisions', async () => {
    const db = openMemoryDb()
    cacheInvalidateAll()
    seedMinimalCard(db)
    const day = isoDay(1)
    db.prepare(
      `INSERT INTO price_history (card_id, timestamp, tcgplayer_market) VALUES (?, ?, ?)`,
    ).run('test-card-1', day, 999)
    db.prepare(
      `INSERT INTO card_grade_history (card_id, grade, ts, price) VALUES (?, ?, ?, ?)`,
    ).run('test-card-1', 'raw', day, 100)

    const r = await request(createApp(db)).get('/api/cards/test-card-1/history')
    expect(r.body.series.length).toBe(1)
    expect(r.body.series[0].price).toBe(100)
    expect(r.body.series[0].source).toBe('pricecharting-grade')
  })

  it('returns psa10 grade series from card_grade_history only', async () => {
    const db = openMemoryDb()
    cacheInvalidateAll()
    seedMinimalCard(db)
    db.prepare(
      `INSERT INTO card_grade_history (card_id, grade, ts, price) VALUES (?, ?, ?, ?)`,
    ).run('test-card-1', 'psa10', isoDay(3), 450)
    db.prepare(
      `INSERT INTO price_history (card_id, timestamp, tcgplayer_market) VALUES (?, ?, ?)`,
    ).run('test-card-1', isoDay(3), 10)

    const r = await request(createApp(db)).get('/api/cards/test-card-1/history?grade=psa10')
    expect(r.status).toBe(200)
    expect(r.body.series.length).toBe(1)
    expect(r.body.series[0].price).toBe(450)
  })

  it('returns a point-in-time single row for bgs10', async () => {
    const db = openMemoryDb()
    cacheInvalidateAll()
    seedMinimalCard(db)
    db.prepare(`UPDATE cards SET pc_price_bgs10 = 1200 WHERE id = ?`).run('test-card-1')

    const r = await request(createApp(db)).get('/api/cards/test-card-1/history?grade=bgs10')
    expect(r.status).toBe(200)
    expect(r.body.pointInTime).toBe(true)
    expect(r.body.series.length).toBe(1)
    expect(r.body.series[0].price).toBe(1200)
  })

  it('returns an empty point-in-time response when bgs10 is unset', async () => {
    const db = openMemoryDb()
    cacheInvalidateAll()
    seedMinimalCard(db)
    const r = await request(createApp(db)).get('/api/cards/test-card-1/history?grade=bgs10')
    expect(r.status).toBe(200)
    expect(r.body.pointInTime).toBe(true)
    expect(r.body.series.length).toBe(0)
  })

  it('rejects unknown grades with 400', async () => {
    const db = openMemoryDb()
    cacheInvalidateAll()
    seedMinimalCard(db)
    const r = await request(createApp(db)).get('/api/cards/test-card-1/history?grade=nonsense')
    expect(r.status).toBe(400)
  })

  it('returns 404 for an unknown card', async () => {
    const db = openMemoryDb()
    cacheInvalidateAll()
    const r = await request(createApp(db)).get('/api/cards/does-not-exist/history')
    expect(r.status).toBe(404)
  })
})

describe('card_grade_history migration', () => {
  it('creates the table and index', () => {
    const db = openMemoryDb()
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='card_grade_history'`)
      .get() as { name?: string } | undefined
    expect(row?.name).toBe('card_grade_history')
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_cgh_card_grade_ts'`)
      .get() as { name?: string } | undefined
    expect(idx?.name).toBe('idx_cgh_card_grade_ts')
  })

  it('enforces (card_id, grade, ts) primary key', () => {
    const db = openMemoryDb()
    seedMinimalCard(db)
    const stmt = db.prepare(
      `INSERT INTO card_grade_history (card_id, grade, ts, price) VALUES (?, ?, ?, ?)`,
    )
    stmt.run('test-card-1', 'psa10', isoDay(1), 500)
    expect(() => stmt.run('test-card-1', 'psa10', isoDay(1), 600)).toThrow()
  })
})
