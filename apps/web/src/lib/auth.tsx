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

export async function refreshAccessToken(): Promise<string | null> {
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
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, loading: true })

  const fetchUser = useCallback(async () => {
    const token = getAccessToken()
    if (!token) {
      const refreshed = await refreshAccessToken()
      if (!refreshed) {
        setState({ user: null, loading: false })
        return
      }
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
  let token = getAccessToken()
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
