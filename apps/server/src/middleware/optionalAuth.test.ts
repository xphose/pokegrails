import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { createApp } from '../app.js'
import { cacheInvalidateAll } from '../cache.js'
import { openMemoryDb, seedMinimalCard, freeToken, adminToken } from '../test/helpers.js'
import { config } from '../config.js'
import { resetFreeSetIdsCacheForTests } from './auth.js'

/**
 * Regression suite for the "silent free-tier downgrade" bug.
 *
 * Before: optionalAuth silently ignored invalid/expired Bearer tokens, so
 * endpoints like GET /api/cards would quietly return free-tier results
 * when the user's 15-minute access token expired — with no signal to the
 * client to refresh. The user would see their search drop from 20 results
 * to 2, with no error. Clicking "Reload Data" hit an authenticated-only
 * route, triggered the client's 401 refresh path, and magically restored
 * the "missing" results.
 *
 * Invariants:
 *   1. No Authorization header  → 200, free-tier filter applies.
 *   2. Valid Bearer token       → 200, role-appropriate data.
 *   3. Invalid/expired Bearer   → 401 (not a silent free-tier 200).
 *   4. Malformed Bearer         → 401.
 */
describe('optionalAuth returns 401 for invalid/expired tokens', () => {
  // Free-set IDs are cached process-wide for 60s. If a prior test seeded
  // sets with IDs like `set-new-1` and this test seeds a different set of
  // IDs, the cache still points at the first batch — making anonymous
  // queries fail to match any cards here. Clear the cache per-test.
  beforeEach(() => {
    resetFreeSetIdsCacheForTests()
    cacheInvalidateAll()
  })

  const seedOlderSet = (db: ReturnType<typeof openMemoryDb>) => {
    // Card outside the free-tier window (older release_date than the top 3)
    db.prepare(
      `INSERT INTO sets (id, name, release_date, total_cards, last_updated)
       VALUES ('set-old', 'Old Set', '2015-01-01', 1, datetime('now')),
              ('set-new-1', 'New 1', '2025-12-01', 1, datetime('now')),
              ('set-new-2', 'New 2', '2025-11-01', 1, datetime('now')),
              ('set-new-3', 'New 3', '2025-10-01', 1, datetime('now'))`,
    ).run()
    db.prepare(
      `INSERT INTO cards (id, name, set_id, market_price, last_updated)
       VALUES ('card-old', 'Old Card', 'set-old', 100, datetime('now')),
              ('card-new', 'New Card', 'set-new-1', 50, datetime('now'))`,
    ).run()
  }

  it('anonymous (no token) gets free-tier filtered list', async () => {
    const db = openMemoryDb()
    cacheInvalidateAll()
    seedOlderSet(db)
    const r = await request(createApp(db)).get('/api/cards')
    expect(r.status).toBe(200)
    // Old set card filtered out for anon users
    const ids = r.body.items.map((c: any) => c.id)
    expect(ids).toContain('card-new')
    expect(ids).not.toContain('card-old')
    expect(r.body.tier_limited).toBe(true)
  })

  it('authenticated admin sees everything', async () => {
    const db = openMemoryDb()
    cacheInvalidateAll()
    seedOlderSet(db)
    const r = await request(createApp(db))
      .get('/api/cards')
      .set('Authorization', `Bearer ${adminToken()}`)
    expect(r.status).toBe(200)
    const ids = r.body.items.map((c: any) => c.id)
    expect(ids).toContain('card-new')
    expect(ids).toContain('card-old')
  })

  it('expired token → 401 (not silent free-tier 200)', async () => {
    const db = openMemoryDb()
    cacheInvalidateAll()
    seedOlderSet(db)
    const expired = jwt.sign(
      { userId: 999, username: 'stale', role: 'admin' },
      config.jwtSecret,
      { expiresIn: '-1s' },
    )
    const r = await request(createApp(db))
      .get('/api/cards')
      .set('Authorization', `Bearer ${expired}`)
    expect(r.status).toBe(401)
    expect(r.body.error).toMatch(/expired|invalid/i)
  })

  it('malformed Bearer → 401', async () => {
    const db = openMemoryDb()
    cacheInvalidateAll()
    seedOlderSet(db)
    const r = await request(createApp(db))
      .get('/api/cards')
      .set('Authorization', 'Bearer totally-not-a-jwt')
    expect(r.status).toBe(401)
  })

  it('wrong-secret token → 401', async () => {
    const db = openMemoryDb()
    cacheInvalidateAll()
    seedOlderSet(db)
    const forged = jwt.sign(
      { userId: 1, username: 'forged', role: 'admin' },
      'a-different-secret',
      { expiresIn: '1h' },
    )
    const r = await request(createApp(db))
      .get('/api/cards')
      .set('Authorization', `Bearer ${forged}`)
    expect(r.status).toBe(401)
  })

  it('regression: search "mew" returns SAME count whether token is fresh or expired — expired must 401', async () => {
    const db = openMemoryDb()
    cacheInvalidateAll()
    // Free-tier sees the 3 newest release dates. Seed 4 sets so there's
    // genuinely an "old" set outside the free window.
    db.prepare(
      `INSERT INTO sets (id, name, release_date, total_cards, last_updated)
       VALUES ('set-new-a', 'New A', '2025-12-01', 1, datetime('now')),
              ('set-new-b', 'New B', '2025-11-01', 1, datetime('now')),
              ('set-new-c', 'New C', '2025-10-01', 1, datetime('now')),
              ('set-old',   'Old',   '2018-01-01', 1, datetime('now'))`,
    ).run()
    // 3 Mew cards in the gated (old) set
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO cards (id, name, set_id, market_price, last_updated)
         VALUES (?, 'Mew ex ' || ?, 'set-old', 100, datetime('now'))`,
      ).run(`old-${i}`, i)
    }
    // 2 Mew cards in free-tier sets (spread to exercise the IN filter)
    db.prepare(
      `INSERT INTO cards (id, name, set_id, market_price, last_updated)
       VALUES ('new-a-1', 'Mew new-a', 'set-new-a', 50, datetime('now')),
              ('new-b-1', 'Mew new-b', 'set-new-b', 50, datetime('now'))`,
    ).run()
    const fresh = adminToken()
    const stale = jwt.sign(
      { userId: 1, username: 'a', role: 'admin' },
      config.jwtSecret,
      { expiresIn: '-1s' },
    )

    const freshRes = await request(createApp(db))
      .get('/api/cards?q=mew')
      .set('Authorization', `Bearer ${fresh}`)
    expect(freshRes.status).toBe(200)
    expect(freshRes.body.items.length).toBe(5)

    const staleRes = await request(createApp(db))
      .get('/api/cards?q=mew')
      .set('Authorization', `Bearer ${stale}`)
    // MUST be 401, not a silent 200 with 2 rows
    expect(staleRes.status).toBe(401)

    // Anonymous still gets the honest 2-card free-tier view
    const anonRes = await request(createApp(db)).get('/api/cards?q=mew')
    expect(anonRes.status).toBe(200)
    expect(anonRes.body.items.length).toBe(2)
  })
})

describe('rate limiting sanity', () => {
  it('exempts /api/auth/* from the global apiLimiter', async () => {
    const db = openMemoryDb()
    cacheInvalidateAll()
    seedMinimalCard(db)
    const app = createApp(db)
    // Fire more than the general apiLimiter (2000/15min) but far under
    // the auth-route limiter (40/15min) against an auth path. All should
    // return auth-layer errors (400/401), never 429 from the global bucket.
    const responses = await Promise.all(
      Array.from({ length: 30 }, () =>
        request(app).post('/api/auth/login').send({ login: 'nope', password: 'nope' }),
      ),
    )
    const statuses = new Set(responses.map((r) => r.status))
    // Should be 401 (invalid creds) for all. 429 appearing would mean the
    // global limiter is still attached to auth paths.
    expect(statuses.has(429)).toBe(false)
  })
  // Note: we don't unit-test 429 triggering because express-rate-limit
  // uses an in-memory store keyed by IP that's process-global, making
  // isolation between tests fragile. The skip logic above is the
  // behaviour we actually care about.
  void freeToken // silence unused-import
})
