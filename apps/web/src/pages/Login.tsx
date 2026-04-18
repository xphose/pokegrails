import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '@/lib/auth'
import { GoogleSignInButton } from '@/components/GoogleSignInButton'

type LoginErrorKind = 'invalid' | 'rate-limited' | 'server' | 'other'
type LoginErrorState = { kind: LoginErrorKind; message: string }

/**
 * Classify a server error message into a UX bucket. The server returns
 * distinct strings — "Invalid credentials" on 401, "Too many login
 * attempts…" on 429 — and we want to surface them with different styling
 * so the user can tell "I typed the password wrong" apart from "the
 * server is telling me to wait" apart from "my session expired while I
 * was on another page".
 */
function classifyError(message: string): LoginErrorState {
  const m = message.toLowerCase()
  if (m.includes('too many')) return { kind: 'rate-limited', message }
  if (m.includes('invalid credentials')) return {
    kind: 'invalid',
    message: 'That username or password is incorrect.',
  }
  if (m.includes('login failed') || m.startsWith('5')) return {
    kind: 'server',
    message: 'Something went wrong on our end. Please try again.',
  }
  return { kind: 'other', message }
}

export function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const routeState = (location.state || {}) as { from?: string; reason?: string }
  const from = routeState.from || '/'
  const sessionExpired = routeState.reason === 'session-expired'

  const [loginVal, setLoginVal] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<LoginErrorState | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      // Trim the login identifier so autofill/paste artifacts don't cause
      // spurious "Invalid credentials" errors. Password is intentionally
      // not trimmed — spaces are legitimate characters in passwords.
      await login(loginVal.trim(), password)
      navigate(from, { replace: true })
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'Login failed'
      setError(classifyError(raw))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-[80vh] items-center justify-center">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-8 shadow-lg">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-primary">PokeGrails</h1>
          <p className="mt-1 text-sm text-muted-foreground">Sign in to your account</p>
        </div>

        <GoogleSignInButton
          onSuccess={() => navigate(from, { replace: true })}
          onError={(msg) => setError(classifyError(msg))}
        />

        <div className="relative my-5">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-border" />
          </div>
          <div className="relative flex justify-center text-xs">
            <span className="bg-card px-3 text-muted-foreground">or continue with email</span>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {sessionExpired && !error && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
              Your session expired. Please sign in again.
            </div>
          )}
          {error && error.kind === 'rate-limited' && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
              {error.message}
            </div>
          )}
          {error && error.kind !== 'rate-limited' && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {error.message}
            </div>
          )}

          <div>
            <label htmlFor="login" className="mb-1.5 block text-sm font-medium text-foreground">
              Username or Email
            </label>
            <input
              id="login"
              type="text"
              value={loginVal}
              onChange={(e) => setLoginVal(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="Enter username or email"
              required
              autoFocus
              autoComplete="username"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-foreground">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="Enter password"
              required
              autoComplete="current-password"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          Don't have an account?{' '}
          <Link to="/register" className="font-medium text-primary hover:underline">
            Create one
          </Link>
        </p>

        <div className="mt-4 rounded-lg border border-border bg-muted/30 px-4 py-3 text-center">
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Free accounts</span> get access to the 3 newest sets.{' '}
            Subscribe to <span className="font-medium text-amber-400">Premium</span> for full catalog access and analytics.
          </p>
        </div>
      </div>
    </div>
  )
}
