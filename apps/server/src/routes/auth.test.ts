import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import request from 'supertest'
import { createApp } from '../app.js'
import { cacheInvalidateAll } from '../cache.js'
import { config } from '../config.js'
import { openMemoryDb } from '../test/helpers.js'

// Security-critical invariants around signup and role assignment.
//
// Background: an earlier version of the signup path implicitly granted 'admin'
// to whichever user was first in the `users` table at the moment of INSERT.
// That was triggered in production, silently handing admin + premium access
// to a brand-new signup. These tests exist to make sure it never happens again.
//
// Invariants enforced here:
//   1. A signup on an empty DB creates a 'free' user. Never 'admin', never 'premium'.
//   2. Any number of subsequent signups are also 'free'.
//   3. The issued JWT reflects the stored role exactly — no privilege escalation
//      in the response body or the token claims.
//   4. The ONLY way signup can produce an 'admin' is an explicit operator opt-in
//      via the BOOTSTRAP_ADMIN_EMAILS allowlist. Unrelated emails still come
//      back as 'free' even when the allowlist is populated.
//   5. The allowlist matches case-insensitively on email, because registration
//      lowercases emails before storage.
//   6. Google OAuth signup obeys the same invariants as password signup.

function readRoleFromDb(db: ReturnType<typeof openMemoryDb>, username: string): string | undefined {
  const row = db.prepare('SELECT role FROM users WHERE username = ?').get(username) as { role: string } | undefined
  return row?.role
}

describe('POST /api/auth/register — role assignment', () => {
  const originalAllowlist = config.bootstrapAdminEmails

  beforeEach(() => {
    cacheInvalidateAll()
    // Reset the allowlist to empty for every test so one test's mutation
    // cannot leak into another.
    config.bootstrapAdminEmails = []
  })

  afterEach(() => {
    config.bootstrapAdminEmails = originalAllowlist
  })

  it('first signup on an empty DB is created as a free user, not admin', async () => {
    const db = openMemoryDb()
    const app = createApp(db)

    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'firstuser', email: 'first@example.com', password: 'correct-horse-battery' })
      .expect(201)

    expect(res.body.user.role).toBe('free')
    expect(readRoleFromDb(db, 'firstuser')).toBe('free')
  })

  it('JWT issued on first signup does not claim admin', async () => {
    const db = openMemoryDb()
    const app = createApp(db)

    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'firstuser', email: 'first@example.com', password: 'correct-horse-battery' })
      .expect(201)

    // Decode the JWT payload without verifying the signature — we only care
    // that the server did not put "admin" into the claims.
    const parts = String(res.body.accessToken).split('.')
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    expect(payload.role).toBe('free')
    expect(payload.role).not.toBe('admin')
    expect(payload.role).not.toBe('premium')
  })

  it('a user granted admin out-of-band does NOT cause subsequent signups to inherit admin', async () => {
    // This is the exact scenario that bit us in prod: there was an admin in
    // the table, then the table state changed, and the next signup silently
    // got admin. The invariant is that role assignment for a new signup is a
    // pure function of (allowlist, provided email) — never of existing rows.
    const db = openMemoryDb()
    db.prepare(
      "INSERT INTO users (username, email, password_hash, role) VALUES ('rootadmin', 'root@example.com', 'x', 'admin')",
    ).run()
    // Then the admin row is deleted, leaving the users table empty again.
    db.prepare('DELETE FROM users').run()

    const app = createApp(db)
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'unrelated', email: 'unrelated@example.com', password: 'correct-horse-battery' })
      .expect(201)

    expect(res.body.user.role).toBe('free')
    expect(readRoleFromDb(db, 'unrelated')).toBe('free')
  })

  it('tenth signup in a populated DB is still free', async () => {
    const db = openMemoryDb()
    const app = createApp(db)

    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: `user${i}`, email: `user${i}@example.com`, password: 'correct-horse-battery' })
        .expect(201)
      expect(res.body.user.role).toBe('free')
    }
  })

  it('never returns premium from signup even if someone requests it in the body', async () => {
    const db = openMemoryDb()
    const app = createApp(db)

    const res = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'sneaky',
        email: 'sneaky@example.com',
        password: 'correct-horse-battery',
        role: 'premium',
        admin: true,
        is_admin: true,
      })
      .expect(201)

    expect(res.body.user.role).toBe('free')
    expect(readRoleFromDb(db, 'sneaky')).toBe('free')
  })

  it('only promotes to admin when the email is in BOOTSTRAP_ADMIN_EMAILS', async () => {
    config.bootstrapAdminEmails = ['owner@example.com']
    const db = openMemoryDb()
    const app = createApp(db)

    const allowed = await request(app)
      .post('/api/auth/register')
      .send({ username: 'owner', email: 'owner@example.com', password: 'correct-horse-battery' })
      .expect(201)
    expect(allowed.body.user.role).toBe('admin')
    expect(readRoleFromDb(db, 'owner')).toBe('admin')

    const unrelated = await request(app)
      .post('/api/auth/register')
      .send({ username: 'other', email: 'other@example.com', password: 'correct-horse-battery' })
      .expect(201)
    expect(unrelated.body.user.role).toBe('free')
    expect(readRoleFromDb(db, 'other')).toBe('free')
  })

  it('allowlist matching is case-insensitive on email', async () => {
    config.bootstrapAdminEmails = ['owner@example.com']
    const db = openMemoryDb()
    const app = createApp(db)

    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'owner', email: 'OWNER@Example.COM', password: 'correct-horse-battery' })
      .expect(201)

    expect(res.body.user.role).toBe('admin')
    expect(readRoleFromDb(db, 'owner')).toBe('admin')
  })
})

describe('POST /api/auth/google — role assignment', () => {
  const originalAllowlist = config.bootstrapAdminEmails
  const originalClientId = config.googleClientId
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    cacheInvalidateAll()
    config.bootstrapAdminEmails = []
    config.googleClientId = 'test-google-client-id'
  })

  afterEach(() => {
    config.bootstrapAdminEmails = originalAllowlist
    config.googleClientId = originalClientId
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  function stubGoogleTokeninfo(info: { sub: string; email: string; name?: string; aud: string }) {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => info,
    })) as unknown as typeof fetch
  }

  it('first Google signup on an empty DB creates a free user, not admin', async () => {
    stubGoogleTokeninfo({ sub: 'g-123', email: 'first@example.com', name: 'First', aud: 'test-google-client-id' })
    const db = openMemoryDb()
    const app = createApp(db)

    const res = await request(app)
      .post('/api/auth/google')
      .send({ credential: 'fake-id-token' })
      .expect(200)

    expect(res.body.user.role).toBe('free')
    const stored = db.prepare('SELECT role FROM users WHERE email = ?').get('first@example.com') as { role: string }
    expect(stored.role).toBe('free')
  })

  it('Google signup only promotes when email is on the allowlist', async () => {
    config.bootstrapAdminEmails = ['owner@example.com']
    stubGoogleTokeninfo({ sub: 'g-456', email: 'owner@example.com', name: 'Owner', aud: 'test-google-client-id' })
    const db = openMemoryDb()
    const app = createApp(db)

    const res = await request(app)
      .post('/api/auth/google')
      .send({ credential: 'fake-id-token' })
      .expect(200)

    expect(res.body.user.role).toBe('admin')
  })

  it('existing Google user keeps their stored role and is never escalated', async () => {
    // Prior-existing free user — a later Google login must not bump them to admin
    // just because their email happens to match the allowlist today.
    config.bootstrapAdminEmails = ['owner@example.com']
    const db = openMemoryDb()
    db.prepare(
      "INSERT INTO users (username, email, password_hash, role) VALUES ('owner', 'owner@example.com', 'x', 'free')",
    ).run()

    stubGoogleTokeninfo({ sub: 'g-789', email: 'owner@example.com', name: 'Owner', aud: 'test-google-client-id' })
    const app = createApp(db)

    const res = await request(app)
      .post('/api/auth/google')
      .send({ credential: 'fake-id-token' })
      .expect(200)

    expect(res.body.user.role).toBe('free')
    const stored = db.prepare('SELECT role FROM users WHERE email = ?').get('owner@example.com') as { role: string }
    expect(stored.role).toBe('free')
  })
})

/**
 * POST /api/auth/login hardening.
 *
 * The production bug this guards against: users report "sometimes my
 * credentials are accepted, sometimes they aren't". We traced two
 * plausible causes that both manifest as a 401 "Invalid credentials"
 * response:
 *   1. The login identifier had whitespace (autofill, paste) so the
 *      users-table lookup missed.
 *   2. The authLimiter was counting successful logins against the
 *      same bucket as failed ones, so a user who signs in on many
 *      tabs / devices could burn through the quota and see 429s —
 *      which the UI used to render identically to invalid credentials.
 *
 * These tests enforce the fixes directly.
 */
function seedUser(db: ReturnType<typeof openMemoryDb>, username: string, email: string, password: string, role = 'free') {
  const hash = bcrypt.hashSync(password, 4) // tiny cost for speed in tests
  db.prepare(
    'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)',
  ).run(username, email, hash, role)
}

describe('POST /api/auth/login — whitespace tolerance', () => {
  beforeEach(() => cacheInvalidateAll())

  it('accepts a login with surrounding whitespace', async () => {
    const db = openMemoryDb()
    seedUser(db, 'admin', 'admin@example.com', 'correct-horse-battery', 'admin')
    const app = createApp(db)

    const res = await request(app)
      .post('/api/auth/login')
      .send({ login: '  admin@example.com  ', password: 'correct-horse-battery' })

    expect(res.status).toBe(200)
    expect(res.body.user.role).toBe('admin')
    expect(res.body.accessToken).toBeTruthy()
  })

  it('accepts whitespace around the username form of the login', async () => {
    const db = openMemoryDb()
    seedUser(db, 'admin', 'admin@example.com', 'correct-horse-battery', 'admin')
    const app = createApp(db)

    const res = await request(app)
      .post('/api/auth/login')
      .send({ login: '\tadmin\n', password: 'correct-horse-battery' })

    expect(res.status).toBe(200)
    expect(res.body.user.username).toBe('admin')
  })

  it('does NOT trim the password', async () => {
    // Spaces are legitimate password characters. If a user set
    // "my password " intentionally, we must preserve it; if we trimmed
    // on their behalf, they'd get locked out of a password they set.
    const db = openMemoryDb()
    seedUser(db, 'alice', 'alice@example.com', 'pw-with-trailing ', 'free')
    const app = createApp(db)

    const good = await request(app)
      .post('/api/auth/login')
      .send({ login: 'alice', password: 'pw-with-trailing ' })
    expect(good.status).toBe(200)

    const bad = await request(app)
      .post('/api/auth/login')
      .send({ login: 'alice', password: 'pw-with-trailing' })
    expect(bad.status).toBe(401)
  })

  it('empty login after trimming returns 400, not 401', async () => {
    const db = openMemoryDb()
    const app = createApp(db)
    const res = await request(app).post('/api/auth/login').send({ login: '   ', password: 'x' })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/auth/login — rate limiting', () => {
  // express-rate-limit uses an in-memory, process-global store keyed by
  // IP. Inside a single `createApp(db)` instance that's stable; across
  // `createApp` calls in the same describe block the SAME middleware is
  // mounted again and shares the same in-memory bucket unless we
  // explicitly construct a new store. To keep these tests isolated we
  // create a fresh app per test and rely on the fact that supertest's
  // ephemeral listener gets a different `req.ip` on each request in
  // localhost mode ... actually it doesn't — every supertest request
  // hits ::ffff:127.0.0.1. So we deliberately burn one bucket per test
  // and assert based on per-test thresholds.
  beforeEach(() => cacheInvalidateAll())

  it('successful logins do NOT consume the failed-attempt budget (skipSuccessfulRequests)', async () => {
    // If successful logins counted toward the 60-per-15min bucket, the
    // 61st successful login would 429. With skipSuccessfulRequests:true
    // we can make 80 successful logins without tripping the limit.
    // We use a reasonably-large number to prove the semantic (not 1000
    // because each bcrypt round is expensive even at cost=4).
    const db = openMemoryDb()
    seedUser(db, 'admin', 'admin@example.com', 'correct-horse-battery', 'admin')
    const app = createApp(db)

    for (let i = 0; i < 80; i++) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ login: 'admin@example.com', password: 'correct-horse-battery' })
      expect(res.status, `login #${i} unexpectedly ${res.status}`).toBe(200)
    }
  }, 30_000)

  it('more than 60 FAILED login attempts in a row trip the limiter with a rate-limit message', async () => {
    const db = openMemoryDb()
    seedUser(db, 'admin', 'admin@example.com', 'correct-horse-battery', 'admin')
    const app = createApp(db)

    const statuses: number[] = []
    const bodies: unknown[] = []
    // Fire 70 bad attempts; once the 60-bucket is exhausted we expect
    // the remaining calls to return 429 with the distinct message.
    for (let i = 0; i < 70; i++) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ login: 'admin@example.com', password: 'wrong' })
      statuses.push(res.status)
      bodies.push(res.body)
    }

    const count429 = statuses.filter((s) => s === 429).length
    const count401 = statuses.filter((s) => s === 401).length
    expect(count401).toBeGreaterThanOrEqual(60)
    expect(count429).toBeGreaterThanOrEqual(1)

    const rateLimitedBody = bodies.find((b) => typeof b === 'object' && b !== null && 'error' in b && String((b as any).error).toLowerCase().includes('too many'))
    expect(rateLimitedBody, 'expected a 429 with a "Too many" message to distinguish from "Invalid credentials"').toBeTruthy()
  }, 30_000)
})

/* ── Cookie-based refresh tokens ──────────────────────────────── */

/**
 * Behavior contract:
 *   1. /login, /register, /google all set a Set-Cookie with
 *      name=pg_refresh, HttpOnly, Path=/api/auth, SameSite=Lax.
 *   2. /refresh accepts either the cookie OR the body (during the
 *      migration window). Cookie wins when both are present.
 *   3. /refresh always rotates the cookie on success — after calling
 *      it once, the next call can omit the body entirely.
 *   4. /logout sends an expired cookie so the browser drops it.
 *   5. Stale / invalid cookies produce 401 AND a cookie-clear header,
 *      so the client can't silently keep sending a broken token.
 */

function pickSetCookie(res: request.Response, name: string): string | null {
  const header = res.headers['set-cookie']
  if (!header) return null
  const arr = Array.isArray(header) ? header : [header]
  return arr.find((c) => c.startsWith(`${name}=`)) ?? null
}

function extractCookieValue(setCookie: string): string | null {
  const eq = setCookie.indexOf('=')
  const semi = setCookie.indexOf(';')
  if (eq < 0) return null
  return setCookie.slice(eq + 1, semi < 0 ? setCookie.length : semi)
}

describe('Refresh tokens — httpOnly cookie issue/rotate/clear', () => {
  beforeEach(() => cacheInvalidateAll())

  it('POST /login sets an HttpOnly SameSite=Lax cookie scoped to /api/auth', async () => {
    const db = openMemoryDb()
    seedUser(db, 'admin', 'admin@example.com', 'correct-horse-battery', 'admin')
    const app = createApp(db)

    const res = await request(app)
      .post('/api/auth/login')
      .send({ login: 'admin@example.com', password: 'correct-horse-battery' })
      .expect(200)

    const cookie = pickSetCookie(res, 'pg_refresh')
    expect(cookie, 'expected pg_refresh cookie on login response').toBeTruthy()
    expect(cookie!.toLowerCase()).toContain('httponly')
    expect(cookie!.toLowerCase()).toContain('samesite=lax')
    expect(cookie!.toLowerCase()).toContain('path=/api/auth')
    expect(extractCookieValue(cookie!)).toBeTruthy()
  })

  it('POST /register issues a refresh cookie', async () => {
    const db = openMemoryDb()
    const app = createApp(db)
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'newone', email: 'new@example.com', password: 'correct-horse-battery' })
      .expect(201)
    expect(pickSetCookie(res, 'pg_refresh')).toBeTruthy()
  })

  it('POST /refresh succeeds using ONLY the cookie (no body token)', async () => {
    const db = openMemoryDb()
    seedUser(db, 'admin', 'admin@example.com', 'correct-horse-battery', 'admin')
    const app = createApp(db)

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ login: 'admin@example.com', password: 'correct-horse-battery' })
      .expect(200)
    const cookie = pickSetCookie(loginRes, 'pg_refresh')!
    const cookieValue = extractCookieValue(cookie)!

    const refreshRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `pg_refresh=${cookieValue}`)
      .send({})
      .expect(200)

    expect(refreshRes.body.accessToken).toBeTruthy()
    // Cookie is rotated on every successful refresh — the new value
    // must differ from the one we sent, or stolen cookies could be
    // replayed indefinitely.
    const rotated = pickSetCookie(refreshRes, 'pg_refresh')
    expect(rotated).toBeTruthy()
    expect(extractCookieValue(rotated!)).not.toBe(cookieValue)
  })

  it('POST /refresh accepts a body token for legacy clients and rotates into cookie', async () => {
    const db = openMemoryDb()
    seedUser(db, 'admin', 'admin@example.com', 'correct-horse-battery', 'admin')
    const app = createApp(db)

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ login: 'admin@example.com', password: 'correct-horse-battery' })
      .expect(200)
    const bodyToken: string = loginRes.body.refreshToken

    // Second call: body ONLY, no cookie. This mimics a legacy client
    // that hasn't been updated yet.
    const refreshRes = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: bodyToken })
      .expect(200)

    expect(refreshRes.body.accessToken).toBeTruthy()
    // The response must set a fresh cookie so subsequent refreshes
    // can drop the body copy.
    const rotated = pickSetCookie(refreshRes, 'pg_refresh')
    expect(rotated, 'legacy-body refresh should still issue a cookie').toBeTruthy()
  })

  it('POST /refresh with no cookie and no body returns 400', async () => {
    const db = openMemoryDb()
    const app = createApp(db)
    const res = await request(app).post('/api/auth/refresh').send({})
    expect(res.status).toBe(400)
  })

  it('POST /refresh with an unknown token clears the cookie on the response', async () => {
    const db = openMemoryDb()
    const app = createApp(db)
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', 'pg_refresh=not-a-real-token')
      .send({})
    expect(res.status).toBe(401)
    const cleared = pickSetCookie(res, 'pg_refresh')
    expect(cleared, 'server must clear the bad cookie').toBeTruthy()
    // clearCookie expresses the clear as expires-in-the-past.
    expect(cleared!.toLowerCase()).toMatch(/expires=thu, 01 jan 1970|max-age=0/)
  })

  it('POST /logout clears the refresh cookie', async () => {
    const db = openMemoryDb()
    seedUser(db, 'admin', 'admin@example.com', 'correct-horse-battery', 'admin')
    const app = createApp(db)

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ login: 'admin@example.com', password: 'correct-horse-battery' })
      .expect(200)
    const accessToken: string = loginRes.body.accessToken

    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({})
      .expect(200)
    const cleared = pickSetCookie(logoutRes, 'pg_refresh')
    expect(cleared).toBeTruthy()
    expect(cleared!.toLowerCase()).toMatch(/expires=thu, 01 jan 1970|max-age=0/)
  })

  it('reused refresh cookie (token already rotated) fails with 401', async () => {
    const db = openMemoryDb()
    seedUser(db, 'admin', 'admin@example.com', 'correct-horse-battery', 'admin')
    const app = createApp(db)

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ login: 'admin@example.com', password: 'correct-horse-battery' })
      .expect(200)
    const original = extractCookieValue(pickSetCookie(loginRes, 'pg_refresh')!)!

    // First refresh — rotates the token.
    await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `pg_refresh=${original}`)
      .send({})
      .expect(200)

    // Replaying the original token must now fail (database row was deleted).
    const replay = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `pg_refresh=${original}`)
      .send({})
    expect(replay.status).toBe(401)
  })
})
