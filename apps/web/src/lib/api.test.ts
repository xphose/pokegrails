import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The api helper + auth module interact through a module-level
// session-expired handler. These tests exercise the paths where a
// previously-authenticated request must NOT silently fall back to
// anonymous — that was the root cause of the "search mew returns
// 2 cards" bug.

// Shared mock state for the fetch spy so each test can set a sequence
// of responses deterministically.
type FetchResponse = { status: number; body?: unknown }
let fetchQueue: FetchResponse[] = []
let fetchCalls: { url: string; init: RequestInit | undefined }[] = []

function mockResponse({ status, body }: FetchResponse): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body ?? '')),
    json: async () => body ?? {},
  } as unknown as Response
}

beforeEach(() => {
  fetchQueue = []
  fetchCalls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, init })
    const next = fetchQueue.shift()
    if (!next) throw new Error(`No queued response for fetch(${url})`)
    return mockResponse(next)
  }))
  // Fresh localStorage between tests so token state never leaks.
  window.localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

/**
 * Build a JWT-shaped string whose payload encodes a future `exp`. The
 * access-token validity check in lib/auth.tsx only reads the payload —
 * it never verifies the signature — so this is sufficient for the
 * "don't proactively refresh" branch.
 */
function mintFakeAccessToken(expSecondsFromNow: number): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=+$/, '')
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }))
    .replace(/=+$/, '')
  return `${header}.${payload}.sig`
}

describe('api() session-expiry behavior', () => {
  it('throws SessionExpiredError when the access token is rejected AND refresh fails', async () => {
    // import after stubbing fetch and clearing localStorage so the
    // module-level token accessors pick up a clean slate
    const { setTokens } = await import('./auth')
    const { api, SessionExpiredError } = await import('./api')

    // Seed a valid-looking (non-expiring) access token + a refresh token.
    setTokens(mintFakeAccessToken(3600), 'rt-abc')

    // First call: 401 (server rejects). Refresh call: 401 (refresh
    // token no longer valid). Because the client *started* with a
    // token, api() must throw rather than retry anonymously.
    fetchQueue.push({ status: 401, body: 'Unauthorized' })
    fetchQueue.push({ status: 401, body: { error: 'Refresh failed' } })

    await expect(api('/api/cards')).rejects.toBeInstanceOf(SessionExpiredError)

    // Crucial assertion: no THIRD fetch was made. Previously api()
    // would re-issue the original request without Authorization, and
    // /api/cards would happily serve the free-tier subset.
    expect(fetchCalls).toHaveLength(2)
    expect(fetchCalls[0]?.url).toBe('/api/cards')
  })

  it('still permits anonymous callers (no token) to reach the endpoint', async () => {
    const { api } = await import('./api')

    // No tokens set. A 401 here is the server saying "this endpoint
    // requires auth" — we surface it as a normal error, NOT a
    // SessionExpiredError, because the user was never signed in.
    fetchQueue.push({ status: 200, body: { items: [], total: 0 } })

    const result = await api<{ items: unknown[]; total: number }>('/api/cards')
    expect(result.total).toBe(0)
    expect(fetchCalls).toHaveLength(1)
    const authHeader = (fetchCalls[0]?.init?.headers as Record<string, string> | undefined)?.Authorization
    expect(authHeader).toBeUndefined()
  })

  it('retries once with the new token when refresh succeeds', async () => {
    const { setTokens, getAccessToken } = await import('./auth')
    const { api } = await import('./api')

    setTokens(mintFakeAccessToken(3600), 'rt-abc')

    fetchQueue.push({ status: 401, body: 'stale' })
    fetchQueue.push({ status: 200, body: { accessToken: 'new-access', refreshToken: 'new-refresh' } })
    fetchQueue.push({ status: 200, body: { items: ['ok'], total: 1 } })

    const result = await api<{ items: string[]; total: number }>('/api/cards')
    expect(result.total).toBe(1)
    expect(getAccessToken()).toBe('new-access')
    // Data request, refresh, retry — exactly three fetches.
    expect(fetchCalls).toHaveLength(3)
    expect(fetchCalls[1]?.url).toBe('/api/auth/refresh')
    const retryAuth = (fetchCalls[2]?.init?.headers as Record<string, string> | undefined)?.Authorization
    expect(retryAuth).toBe('Bearer new-access')
  })
})
