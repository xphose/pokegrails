import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useLocation } from 'react-router-dom'

export type UserRole = 'free' | 'premium' | 'admin'

/**
 * Thrown by api()/authApi() when a request was made on behalf of an
 * authenticated user but the refresh token could not be renewed. The
 * AuthProvider installs a module-level handler that clears the session,
 * invalidates the React Query cache, and navigates the user to /login.
 *
 * This exists to kill the "silent free-tier downgrade" class of bug —
 * previously api() would fall through and retry the original request
 * without an Authorization header, and endpoints like /api/cards would
 * happily return the ~3-set free-tier subset. Users saw "2 Mew cards"
 * and no indication that re-auth was needed.
 */
export class SessionExpiredError extends Error {
  constructor(message = 'Session expired') {
    super(message)
    this.name = 'SessionExpiredError'
  }
}

type SessionExpiredHandler = () => void
let sessionExpiredHandler: SessionExpiredHandler | null = null

/**
 * Called by api()/authApi() when a session-level 401 hits. Deduplicates
 * rapid back-to-back invocations (lots of in-flight fetches all 401ing
 * at once) via a trailing-edge debounce so the user only sees one
 * redirect and React Query is invalidated once.
 */
let expiryPending = false
export function notifySessionExpired(): void {
  if (expiryPending) return
  expiryPending = true
  queueMicrotask(() => {
    expiryPending = false
    sessionExpiredHandler?.()
  })
}

function setSessionExpiredHandler(fn: SessionExpiredHandler | null): void {
  sessionExpiredHandler = fn
}

export interface User {
  id: number
  username: string
  email: string
  role: UserRole
  display_name?: string | null
}

interface AuthState {
  user: User | null
  loading: boolean
}

interface AuthContextType extends AuthState {
  login: (login: string, password: string) => Promise<void>
  register: (username: string, email: string, password: string) => Promise<void>
  loginWithGoogle: (credential: string) => Promise<void>
  logout: () => void
  isAdmin: boolean
  isPremium: boolean
}

const AuthContext = createContext<AuthContextType | null>(null)

const ACCESS_TOKEN_KEY = 'pokegrails_access_token'
// Legacy key. We no longer *store* new refresh tokens here, but we read
// any existing value once on startup so a logged-in session created
// before this change can transparently migrate to the httpOnly cookie
// without forcing the user to sign in again. The first successful
// refresh clears the key.
const LEGACY_REFRESH_TOKEN_KEY = 'pokegrails_refresh_token'

function safeGetItem(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

function safeSetItem(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* noop */ }
}

function safeRemoveItem(key: string) {
  try { localStorage.removeItem(key) } catch { /* noop */ }
}

export function getAccessToken(): string | null {
  return safeGetItem(ACCESS_TOKEN_KEY)
}

/**
 * Legacy signature kept for call-site compatibility. The refresh token
 * is now set by the server as an httpOnly cookie on every login /
 * register / google / refresh response, so we no longer persist it in
 * JS-visible storage (XSS-hardening). `refresh` is ignored.
 */
export function setTokens(access: string, _refresh?: string) {
  safeSetItem(ACCESS_TOKEN_KEY, access)
  // Defense-in-depth: if a legacy refresh token is still sitting in
  // localStorage from before this migration, wipe it now that we have
  // a fresh access token. The cookie is authoritative going forward.
  safeRemoveItem(LEGACY_REFRESH_TOKEN_KEY)
}

export function clearTokens() {
  safeRemoveItem(ACCESS_TOKEN_KEY)
  safeRemoveItem(LEGACY_REFRESH_TOKEN_KEY)
}

function getLegacyRefreshToken(): string | null {
  return safeGetItem(LEGACY_REFRESH_TOKEN_KEY)
}

/**
 * Pull the `exp` claim (seconds since epoch) out of a JWT without verifying
 * the signature. Client-side we only use this as a "is this token stale?"
 * hint — the server always re-verifies, so there's no security consequence
 * to reading an untrusted payload here. Returns 0 for malformed tokens,
 * which the caller treats as "expired" and refreshes.
 */
function readJwtExpSeconds(token: string): number {
  const parts = token.split('.')
  if (parts.length !== 3) return 0
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
    return typeof payload.exp === 'number' ? payload.exp : 0
  } catch {
    return 0
  }
}

// Refresh a few seconds before expiry rather than waiting for the server
// to 401. This avoids a whole class of UX bugs where an endpoint that
// *could* serve a free-tier response (e.g. /api/cards with optionalAuth)
// silently downgrades the user without signaling re-auth.
const REFRESH_BUFFER_SEC = 30

/**
 * Serialize concurrent refresh calls: if three parallel fetches all see an
 * expired token and all try to refresh, only the first hits the network;
 * the others await the same promise. Without this, the first-to-finish
 * would rotate the refresh token and invalidate the others mid-flight.
 */
let inflightRefresh: Promise<string | null> | null = null

export async function refreshAccessToken(): Promise<string | null> {
  if (inflightRefresh) return inflightRefresh
  inflightRefresh = (async () => {
    // Prefer the httpOnly cookie the server set on login. A legacy body
    // token is sent exactly once — during the first refresh after this
    // migration — to avoid forcing pre-existing sessions to re-auth.
    const legacyRt = getLegacyRefreshToken()
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: legacyRt ? JSON.stringify({ refreshToken: legacyRt }) : JSON.stringify({}),
      })
      if (!res.ok) {
        clearTokens()
        return null
      }
      const data = await res.json() as { accessToken: string; refreshToken?: string }
      setTokens(data.accessToken)
      return data.accessToken
    } catch {
      clearTokens()
      return null
    } finally {
      setTimeout(() => { inflightRefresh = null }, 0)
    }
  })()
  return inflightRefresh
}

/**
 * Get a valid access token, proactively refreshing if expiry is within
 * REFRESH_BUFFER_SEC. Returns null if no session or refresh failed. All
 * authenticated fetch helpers (this file + lib/api.ts) go through this.
 */
export async function getValidAccessToken(): Promise<string | null> {
  const t = getAccessToken()
  if (!t) return null
  const exp = readJwtExpSeconds(t)
  const nowSec = Math.floor(Date.now() / 1000)
  if (exp > 0 && exp - nowSec > REFRESH_BUFFER_SEC) return t
  return refreshAccessToken()
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, loading: true })
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()

  const fetchUser = useCallback(async () => {
    const token = await getValidAccessToken()
    if (!token) {
      setState({ user: null, loading: false })
      return
    }
    try {
      const data = await authApi<{ user: User }>('/api/auth/me')
      setState({ user: data.user, loading: false })
    } catch {
      clearTokens()
      setState({ user: null, loading: false })
    }
  }, [])

  useEffect(() => { fetchUser() }, [fetchUser])

  // Install the global session-expiry handler. When any api()/authApi()
  // call detects that a previously-authenticated request cannot be
  // refreshed, this fires: clear tokens, blow away the React Query cache
  // (so no stale "authenticated" data is shown to the now-anonymous
  // session), reset user state, and bounce to /login with a reason so
  // the login page can explain what happened instead of the user seeing
  // a generic error.
  useEffect(() => {
    setSessionExpiredHandler(() => {
      clearTokens()
      queryClient.clear()
      setState({ user: null, loading: false })
      // Preserve the current path so we can return after sign-in. Only
      // navigate when not already on a public route.
      const pathname = location.pathname
      if (pathname !== '/login' && pathname !== '/register') {
        navigate('/login', {
          replace: true,
          state: { from: pathname, reason: 'session-expired' },
        })
      }
    })
    return () => setSessionExpiredHandler(null)
  }, [queryClient, navigate, location.pathname])

  const login = async (login: string, password: string) => {
    const data = await authApi<{ user: User; accessToken: string }>(
      '/api/auth/login',
      { method: 'POST', body: JSON.stringify({ login, password }) },
    )
    setTokens(data.accessToken)
    setState({ user: data.user, loading: false })
  }

  const register = async (username: string, email: string, password: string) => {
    const data = await authApi<{ user: User; accessToken: string }>(
      '/api/auth/register',
      { method: 'POST', body: JSON.stringify({ username, email, password }) },
    )
    setTokens(data.accessToken)
    setState({ user: data.user, loading: false })
  }

  const loginWithGoogle = async (credential: string) => {
    const data = await authApi<{ user: User; accessToken: string }>(
      '/api/auth/google',
      { method: 'POST', body: JSON.stringify({ credential }) },
    )
    setTokens(data.accessToken)
    setState({ user: data.user, loading: false })
  }

  const logout = () => {
    const token = getAccessToken()
    if (token) {
      // credentials:'include' lets the server clear the refresh cookie
      // in the response's Set-Cookie header.
      fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      }).catch(() => {})
    }
    clearTokens()
    setState({ user: null, loading: false })
  }

  return (
    <AuthContext.Provider
      value={{
        ...state,
        login,
        register,
        loginWithGoogle,
        logout,
        isAdmin: state.user?.role === 'admin',
        isPremium: state.user?.role === 'premium' || state.user?.role === 'admin',
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

/**
 * Internal helper shared by /api/auth/* calls (login, register, me,
 * refresh, logout). Unlike lib/api.ts's `api()` which is for general
 * authed data fetching, authApi is also used during sign-in where no
 * token exists yet — so it tolerates missing tokens for public flows.
 *
 * If the caller *was* authenticated (had a token) and the 401-retry
 * refresh fails, we raise SessionExpiredError so the AuthProvider can
 * clear the session. The only path that reaches this state is a
 * corrupted/expired refresh token for an otherwise-logged-in user.
 */
async function authApi<T>(path: string, init?: RequestInit): Promise<T> {
  const startedWithToken = !!getAccessToken()
  const token = await getValidAccessToken()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  // All auth routes need credentials:'include' so the httpOnly refresh
  // cookie flows both ways (server sets it on login, browser sends it
  // on refresh). Same-origin in prod, so this is mostly defensive.
  let res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: { ...headers, ...init?.headers },
  })

  if (res.status === 401 && token) {
    const newToken = await refreshAccessToken()
    if (newToken) {
      headers['Authorization'] = `Bearer ${newToken}`
      res = await fetch(path, {
        ...init,
        credentials: 'include',
        headers: { ...headers, ...init?.headers },
      })
    } else if (startedWithToken) {
      notifySessionExpired()
      throw new SessionExpiredError()
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error || `${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}
