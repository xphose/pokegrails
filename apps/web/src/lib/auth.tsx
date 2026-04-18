import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'

export type UserRole = 'free' | 'premium' | 'admin'

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
const REFRESH_TOKEN_KEY = 'pokegrails_refresh_token'

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

export function setTokens(access: string, refresh: string) {
  safeSetItem(ACCESS_TOKEN_KEY, access)
  safeSetItem(REFRESH_TOKEN_KEY, refresh)
}

export function clearTokens() {
  safeRemoveItem(ACCESS_TOKEN_KEY)
  safeRemoveItem(REFRESH_TOKEN_KEY)
}

function getRefreshToken(): string | null {
  return safeGetItem(REFRESH_TOKEN_KEY)
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
    const rt = getRefreshToken()
    if (!rt) return null
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      })
      if (!res.ok) {
        clearTokens()
        return null
      }
      const data = await res.json() as { accessToken: string; refreshToken: string }
      setTokens(data.accessToken, data.refreshToken)
      return data.accessToken
    } catch {
      clearTokens()
      return null
    } finally {
      // allow the next refresh attempt even if this one errored
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

  const login = async (login: string, password: string) => {
    const data = await authApi<{ user: User; accessToken: string; refreshToken: string }>(
      '/api/auth/login',
      { method: 'POST', body: JSON.stringify({ login, password }) },
    )
    setTokens(data.accessToken, data.refreshToken)
    setState({ user: data.user, loading: false })
  }

  const register = async (username: string, email: string, password: string) => {
    const data = await authApi<{ user: User; accessToken: string; refreshToken: string }>(
      '/api/auth/register',
      { method: 'POST', body: JSON.stringify({ username, email, password }) },
    )
    setTokens(data.accessToken, data.refreshToken)
    setState({ user: data.user, loading: false })
  }

  const loginWithGoogle = async (credential: string) => {
    const data = await authApi<{ user: User; accessToken: string; refreshToken: string }>(
      '/api/auth/google',
      { method: 'POST', body: JSON.stringify({ credential }) },
    )
    setTokens(data.accessToken, data.refreshToken)
    setState({ user: data.user, loading: false })
  }

  const logout = () => {
    const token = getAccessToken()
    if (token) {
      fetch('/api/auth/logout', {
        method: 'POST',
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

async function authApi<T>(path: string, init?: RequestInit): Promise<T> {
  let token = await getValidAccessToken()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  let res = await fetch(path, { ...init, headers: { ...headers, ...init?.headers } })

  if (res.status === 401 && token) {
    const newToken = await refreshAccessToken()
    if (newToken) {
      headers['Authorization'] = `Bearer ${newToken}`
      res = await fetch(path, { ...init, headers: { ...headers, ...init?.headers } })
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error || `${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}
