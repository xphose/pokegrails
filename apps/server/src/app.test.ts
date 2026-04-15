import { describe, expect, it, beforeEach } from 'vitest'
import request from 'supertest'
import { createApp } from './app.js'
import { openMemoryDb, seedMinimalCard } from './test/helpers.js'

describe('createApp', () => {
  let db: ReturnType<typeof openMemoryDb>

  beforeEach(() => {
    db = openMemoryDb()
  })

  it('GET /api/health returns ok with zero cards', async () => {
    const app = createApp(db)
    const res = await request(app).get('/api/health').expect(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.cards).toBe(0)
  })

  it('GET /api/cards returns seeded card', async () => {
    seedMinimalCard(db)
    const app = createApp(db)
    const res = await request(app).get('/api/cards').expect(200)
    expect(Array.isArray(res.body.items)).toBe(true)
    expect(res.body.total).toBe(1)
    expect(res.body.items.length).toBe(1)
    expect(res.body.items[0].name).toBe('Pikachu')
    expect(typeof res.body.items[0].ai_score).toBe('number')
    expect(Array.isArray(res.body.items[0].spark_30d)).toBe(true)
  })

  it('GET /api/cards includes spark_30d from pricecharting history fallback', async () => {
    seedMinimalCard(db)
    db.prepare(`UPDATE cards SET market_price = NULL WHERE id = 'test-card-1'`).run()
    db.prepare(
      `INSERT INTO price_history (card_id, timestamp, tcgplayer_market, tcgplayer_low, ebay_median, pricecharting_median)
       VALUES (?, ?, NULL, NULL, NULL, ?)`,
    ).run('test-card-1', '2025-01-10T00:00:00.000Z', 9.5)
    db.prepare(
      `INSERT INTO price_history (card_id, timestamp, tcgplayer_market, tcgplayer_low, ebay_median, pricecharting_median)
       VALUES (?, ?, NULL, NULL, NULL, ?)`,
    ).run('test-card-1', '2025-01-05T00:00:00.000Z', 8.75)

    const app = createApp(db)
    const res = await request(app).get('/api/cards').expect(200)
    expect(Array.isArray(res.body.items[0].spark_30d)).toBe(true)
    expect(res.body.items[0].spark_30d.length).toBe(2)
    expect(res.body.items[0].spark_30d[0]).toEqual({ p: 8.75 })
    expect(res.body.items[0].spark_30d[1]).toEqual({ p: 9.5 })
  })

  it('GET /api/meta/card-filters returns set ids and print buckets', async () => {
    seedMinimalCard(db)
    const app = createApp(db)
    const res = await request(app).get('/api/meta/card-filters').expect(200)
    expect(res.body.setIds).toContain('test-set')
    expect(Array.isArray(res.body.sets)).toBe(true)
    const ts = res.body.sets.find((s: { id: string }) => s.id === 'test-set')
    expect(ts?.name).toBe('Test Set')
    expect(res.body.printBuckets).toContain('Ultra Rare')
  })

  it('GET /api/cards filters by set_id and print, sorts by name asc', async () => {
    seedMinimalCard(db)
    db.prepare(
      `INSERT INTO cards (
        id, name, set_id, rarity, image_url, character_name, card_type,
        market_price, pull_cost_score, desirability_score, predicted_price, valuation_flag, last_updated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(
      'test-card-2',
      'Abra',
      'test-set',
      'Illustration Rare',
      null,
      'Abra',
      'Illustration Rare',
      5,
      4,
      5,
      8,
      '🟡 FAIRLY VALUED',
    )
    const app = createApp(db)
    const bySet = await request(app).get('/api/cards?set_id=test-set').expect(200)
    expect(bySet.body.items.length).toBe(2)
    const printIr = await request(app).get('/api/cards?print=Illustration%20Rare').expect(200)
    expect(printIr.body.items.length).toBe(1)
    expect(printIr.body.items[0].name).toBe('Abra')
    const sorted = await request(app).get('/api/cards?sort=name&order=asc').expect(200)
    expect(sorted.body.items.map((c: { name: string }) => c.name)).toEqual(['Abra', 'Pikachu'])
  })

  it('GET /api/cards/:id returns 404 when missing', async () => {
    const app = createApp(db)
    await request(app).get('/api/cards/missing-id').expect(404)
  })

  it('GET /api/cards/:id returns full available history with pricecharting fallback', async () => {
    seedMinimalCard(db)
    db.prepare(
      `INSERT INTO price_history (card_id, timestamp, tcgplayer_market, tcgplayer_low, ebay_median, pricecharting_median)
       VALUES (?, ?, ?, NULL, NULL, ?)`,
    ).run('test-card-1', '2024-01-01T00:00:00.000Z', null, 3.25)
    db.prepare(
      `INSERT INTO price_history (card_id, timestamp, tcgplayer_market, tcgplayer_low, ebay_median, pricecharting_median)
       VALUES (?, ?, ?, NULL, NULL, ?)`,
    ).run('test-card-1', '2025-01-01T00:00:00.000Z', 12.5, null)

    const app = createApp(db)
    const res = await request(app).get('/api/cards/test-card-1').expect(200)
    expect(Array.isArray(res.body.priceHistory)).toBe(true)
    expect(res.body.priceHistory.length).toBe(2)
    expect(res.body.priceHistory[0].timestamp).toBe('2025-01-01T00:00:00.000Z')
    expect(res.body.priceHistory[0].tcgplayer_market).toBe(12.5)
    expect(res.body.priceHistory[1].timestamp).toBe('2024-01-01T00:00:00.000Z')
    expect(res.body.priceHistory[1].tcgplayer_market).toBe(3.25)
  })

  it('GET /api/cards/:id/buy-links returns links', async () => {
    seedMinimalCard(db)
    const app = createApp(db)
    const res = await request(app).get('/api/cards/test-card-1/buy-links').expect(200)
    expect(res.body.tcgplayer).toContain('tcgplayer.com')
    expect(res.body.ebay).toContain('ebay.com')
  })

  it('GET /api/dashboard returns KPI shape', async () => {
    seedMinimalCard(db)
    const app = createApp(db)
    const res = await request(app).get('/api/dashboard').expect(200)
    expect(res.body).toMatchObject({
      totalCards: 1,
      undervaluedSignals: 0,
      avgModelAccuracy: 0.88,
      portfolioValue: 0,
    })
  })

  it('POST /api/watchlist creates row', async () => {
    seedMinimalCard(db)
    const app = createApp(db)
    await request(app)
      .post('/api/watchlist')
      .send({ card_id: 'test-card-1', quantity: 2, target_buy_price: 8 })
      .expect(200)
    const rows = db.prepare(`SELECT * FROM watchlist`).all() as { card_id: string; quantity: number }[]
    expect(rows.length).toBe(1)
    expect(rows[0].card_id).toBe('test-card-1')
    expect(rows[0].quantity).toBe(2)
  })

  it('GET /api/signals accepts sort query', async () => {
    seedMinimalCard(db)
    const app = createApp(db)
    const res = await request(app).get('/api/signals?sort=discount').expect(200)
    expect(Array.isArray(res.body)).toBe(true)
  })

  it('GET /api/signals filters by set_id and supports sort=set', async () => {
    seedMinimalCard(db)
    db.prepare(`UPDATE cards SET valuation_flag = 'UNDERVALUED' WHERE id = 'test-card-1'`).run()
    const app = createApp(db)
    const all = await request(app).get('/api/signals').expect(200)
    expect(all.body.length).toBe(1)
    const bySet = await request(app).get('/api/signals?set_id=test-set').expect(200)
    expect(bySet.body.length).toBe(1)
    const bySetEmpty = await request(app).get('/api/signals?set_id=other-set').expect(200)
    expect(bySetEmpty.body.length).toBe(0)
    const sorted = await request(app).get('/api/signals?sort=set').expect(200)
    expect(Array.isArray(sorted.body)).toBe(true)
  })

  it('GET /api/cards/:id/investment returns enriched model output', async () => {
    seedMinimalCard(db)
    const app = createApp(db)
    const res = await request(app).get('/api/cards/test-card-1/investment').expect(200)
    expect(res.body.card_name).toBe('Pikachu')
    expect(typeof res.body.composite_score).toBe('number')
    expect(res.body.signal_breakdown).toBeTruthy()
    expect(res.body.negotiation).toBeTruthy()
  })

  it('GET /api/alerts returns array payload', async () => {
    seedMinimalCard(db)
    const app = createApp(db)
    const res = await request(app).get('/api/alerts').expect(200)
    expect(Array.isArray(res.body)).toBe(true)
  })

  it('GET /api/cards/:id/buy-links includes set name and collector number', async () => {
    seedMinimalCard(db)
    const app = createApp(db)
    const res = await request(app).get('/api/cards/test-card-1/buy-links').expect(200)
    const { tcgplayer, ebay, whatnot } = res.body
    expect(decodeURIComponent(tcgplayer)).toContain('Test Set')
    expect(decodeURIComponent(tcgplayer)).toContain('Pikachu')
    expect(decodeURIComponent(ebay)).toContain('Test Set')
    expect(decodeURIComponent(ebay)).toContain('Pikachu')
    expect(decodeURIComponent(ebay)).toContain('1')
    expect(ebay).toContain('LH_Sold=1')
    expect(decodeURIComponent(whatnot)).toContain('Pikachu')
  })

  it('GET /api/cards/:id/buy-links returns 404 for missing card', async () => {
    const app = createApp(db)
    await request(app).get('/api/cards/nonexistent/buy-links').expect(404)
  })

  it('GET /api/track-record returns structure with expected fields', async () => {
    seedMinimalCard(db)
    const app = createApp(db)
    const res = await request(app).get('/api/track-record').expect(200)
    expect(typeof res.body.confidence_score).toBe('number')
    expect(typeof res.body.prediction_accuracy_pct).toBe('number')
    expect(typeof res.body.buy_signal_hit_rate).toBe('number')
    expect(typeof res.body.buy_signal_avg_return).toBe('number')
    expect(typeof res.body.total_signals_evaluated).toBe('number')
    expect(typeof res.body.active_signals).toBe('number')
    expect(Array.isArray(res.body.accuracy_timeline)).toBe(true)
    expect(Array.isArray(res.body.top_winners)).toBe(true)
    expect(Array.isArray(res.body.notable_misses)).toBe(true)
    expect(Array.isArray(res.body.active_signal_details)).toBe(true)
    expect(Array.isArray(res.body.prediction_vs_actual)).toBe(true)
    expect(res.body.meta).toBeDefined()
    expect(typeof res.body.meta.total_cards_tracked).toBe('number')
    expect(typeof res.body.meta.signal_evaluation_threshold_days).toBe('number')
  })

  it('POST /api/track-record/snapshot creates prediction snapshot', async () => {
    seedMinimalCard(db)
    const app = createApp(db)
    await request(app).post('/api/track-record/snapshot').expect(200)
    const rows = db.prepare('SELECT * FROM prediction_snapshots').all()
    expect(rows.length).toBe(1)
  })
})

describe('GET /api/arbitrage', () => {
  it('returns json array (may call FX)', async () => {
    const db = openMemoryDb()
    seedMinimalCard(db)
    const app = createApp(db)
    const res = await request(app).get('/api/arbitrage').timeout(15000).expect(200)
    expect(Array.isArray(res.body)).toBe(true)
  })
})

describe('Model run endpoints', () => {
  let db: ReturnType<typeof openMemoryDb>

  beforeEach(() => {
    db = openMemoryDb()
    seedMinimalCard(db)
  })

  it('GET /api/models/progress returns full progress shape', async () => {
    const app = createApp(db)
    const res = await request(app).get('/api/models/progress').expect(200)
    expect(typeof res.body.running).toBe('boolean')
    expect(Array.isArray(res.body.completed)).toBe(true)
    expect(Array.isArray(res.body.queued)).toBe(true)
    expect(typeof res.body.total).toBe('number')
    expect(typeof res.body.elapsed_ms).toBe('number')
    expect('finished_at' in res.body).toBe(true)
    expect('error' in res.body).toBe(true)
  })

  it('POST /api/models/run/:modelId returns 404 for unknown model', async () => {
    const app = createApp(db)
    await request(app).post('/api/models/run/nonexistent').expect(404)
  })

  it('POST /api/models/run-all starts a run', async () => {
    const app = createApp(db)
    const res = await request(app).post('/api/models/run-all').expect(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.started_at).toBeTruthy()
  })

  it('GET /api/models/status returns array with expected fields', async () => {
    const app = createApp(db)
    const res = await request(app).get('/api/models/status').expect(200)
    expect(Array.isArray(res.body)).toBe(true)
    if (res.body.length > 0) {
      const m = res.body[0]
      expect(typeof m.name).toBe('string')
      expect(typeof m.model_id).toBe('string')
      expect(typeof m.card_coverage).toBe('number')
      expect(typeof m.total_cards).toBe('number')
      expect(typeof m.status).toBe('string')
    }
  })
})

describe('Paginated analytics endpoints', () => {
  it('GET /api/models/momentum/cards returns paginated shape', async () => {
    const db = openMemoryDb()
    seedMinimalCard(db)
    const app = createApp(db)
    const res = await request(app).get('/api/models/momentum/cards').expect(200)
    expect(typeof res.body.items).toBe('object')
    expect(Array.isArray(res.body.items)).toBe(true)
    expect(typeof res.body.total).toBe('number')
  })

  it('GET /api/models/anomalies/recent returns paginated shape', async () => {
    const db = openMemoryDb()
    seedMinimalCard(db)
    const app = createApp(db)
    const res = await request(app).get('/api/models/anomalies/recent').expect(200)
    expect(Array.isArray(res.body.items)).toBe(true)
    expect(typeof res.body.total).toBe('number')
  })

  it('GET /api/models/supply-shock/alerts returns paginated shape', async () => {
    const db = openMemoryDb()
    seedMinimalCard(db)
    const app = createApp(db)
    const res = await request(app).get('/api/models/supply-shock/alerts').expect(200)
    expect(Array.isArray(res.body.items)).toBe(true)
    expect(typeof res.body.total).toBe('number')
  })

  it('GET /api/models/cointegration/pairs returns paginated shape', async () => {
    const db = openMemoryDb()
    seedMinimalCard(db)
    const app = createApp(db)
    const res = await request(app).get('/api/models/cointegration/pairs').expect(200)
    expect(Array.isArray(res.body.items)).toBe(true)
    expect(typeof res.body.total).toBe('number')
  })

  it('limit and offset query params are respected', async () => {
    const db = openMemoryDb()
    seedMinimalCard(db)
    const app = createApp(db)
    const res = await request(app).get('/api/models/momentum/cards?limit=1&offset=0').expect(200)
    expect(res.body.items.length).toBeLessThanOrEqual(1)
  })
})

describe('Negotiation pricing', () => {
  it('negotiation prices are below market price', async () => {
    const db = openMemoryDb()
    seedMinimalCard(db)
    const app = createApp(db)
    const res = await request(app).get('/api/cards/test-card-1/investment').expect(200)
    const { negotiation } = res.body
    expect(negotiation.opening_offer).toBeLessThan(negotiation.max_pay)
    expect(negotiation.ideal_price).toBeLessThan(negotiation.max_pay)
    expect(negotiation.opening_offer).toBeLessThan(negotiation.ideal_price)
    expect(negotiation.opening_offer).toBeGreaterThan(0)
  })
})

describe('30d sparkline / trend', () => {
  function seedPriceHistory(
    db: ReturnType<typeof openMemoryDb>,
    cardId: string,
    entries: { date: string; price: number }[],
  ) {
    const stmt = db.prepare(
      `INSERT INTO price_history (card_id, timestamp, tcgplayer_market, tcgplayer_low)
       VALUES (?, ?, ?, ?)`,
    )
    for (const e of entries) {
      stmt.run(cardId, e.date, e.price, e.price * 0.9)
    }
  }

  it('spark_30d deduplicates multiple snapshots per day to one point per date', async () => {
    const db = openMemoryDb()
    seedMinimalCard(db)
    seedPriceHistory(db, 'test-card-1', [
      { date: '2025-03-01T06:00:00Z', price: 10 },
      { date: '2025-03-01T12:00:00Z', price: 10.1 },
      { date: '2025-03-01T18:00:00Z', price: 10.2 },
      { date: '2025-03-02T06:00:00Z', price: 11 },
      { date: '2025-03-02T12:00:00Z', price: 11.1 },
      { date: '2025-03-03T08:00:00Z', price: 12 },
    ])
    const app = createApp(db)
    const res = await request(app).get('/api/cards').expect(200)
    const spark = res.body.items[0].spark_30d
    expect(spark.length).toBe(3)
  })

  it('spark_30d spans 30 days even with many snapshots per day', async () => {
    const db = openMemoryDb()
    seedMinimalCard(db)

    const entries: { date: string; price: number }[] = []
    const base = new Date('2025-03-01')
    for (let d = 0; d < 30; d++) {
      const day = new Date(base.getTime() + d * 86_400_000)
      const dateStr = day.toISOString().slice(0, 10)
      const price = 10 + d * 0.5
      entries.push({ date: `${dateStr}T06:00:00Z`, price })
      entries.push({ date: `${dateStr}T12:00:00Z`, price: price + 0.01 })
      entries.push({ date: `${dateStr}T18:00:00Z`, price: price + 0.02 })
    }
    seedPriceHistory(db, 'test-card-1', entries)

    const app = createApp(db)
    const res = await request(app).get('/api/cards').expect(200)
    const spark: { p: number }[] = res.body.items[0].spark_30d
    expect(spark.length).toBe(30)
  })

  it('spark_30d first and last prices reflect actual 30-day range', async () => {
    const db = openMemoryDb()
    seedMinimalCard(db)

    const entries: { date: string; price: number }[] = []
    const base = new Date('2025-03-01')
    for (let d = 0; d < 20; d++) {
      const day = new Date(base.getTime() + d * 86_400_000)
      const dateStr = day.toISOString().slice(0, 10)
      const price = 10 + d
      entries.push({ date: `${dateStr}T12:00:00Z`, price })
    }
    seedPriceHistory(db, 'test-card-1', entries)

    const app = createApp(db)
    const res = await request(app).get('/api/cards').expect(200)
    const spark: { p: number }[] = res.body.items[0].spark_30d
    expect(spark.length).toBe(20)
    expect(spark[0].p).toBe(10)
    expect(spark[spark.length - 1].p).toBe(29)
  })

  it('30d trend is non-zero when prices change over the period', async () => {
    const db = openMemoryDb()
    seedMinimalCard(db)

    const entries: { date: string; price: number }[] = []
    const base = new Date('2025-03-01')
    for (let d = 0; d < 15; d++) {
      const day = new Date(base.getTime() + d * 86_400_000)
      const dateStr = day.toISOString().slice(0, 10)
      entries.push({ date: `${dateStr}T12:00:00Z`, price: 10 + d * 2 })
    }
    seedPriceHistory(db, 'test-card-1', entries)

    const app = createApp(db)
    const res = await request(app).get('/api/cards').expect(200)
    const spark: { p: number }[] = res.body.items[0].spark_30d
    const first = spark[0].p
    const last = spark[spark.length - 1].p
    const changePct = ((last - first) / first) * 100
    expect(Math.abs(changePct)).toBeGreaterThan(1)
  })

  it('spark_30d is sorted chronologically (oldest first)', async () => {
    const db = openMemoryDb()
    seedMinimalCard(db)

    const entries: { date: string; price: number }[] = []
    const base = new Date('2025-03-01')
    for (let d = 0; d < 10; d++) {
      const day = new Date(base.getTime() + d * 86_400_000)
      const dateStr = day.toISOString().slice(0, 10)
      entries.push({ date: `${dateStr}T12:00:00Z`, price: 10 + d })
    }
    seedPriceHistory(db, 'test-card-1', entries)

    const app = createApp(db)
    const res = await request(app).get('/api/cards').expect(200)
    const spark: { p: number }[] = res.body.items[0].spark_30d
    for (let i = 1; i < spark.length; i++) {
      expect(spark[i].p).toBeGreaterThan(spark[i - 1].p)
    }
  })
})
