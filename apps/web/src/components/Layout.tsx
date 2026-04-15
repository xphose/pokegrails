import { useEffect, useState, useRef } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { applyThemeMode, getStoredThemeMode, setStoredThemeMode, type ThemeMode } from '@/lib/theme'
import { HelpMenuButton } from '@/components/help-center'
import { useAuth } from '@/lib/auth'

const tabs: { to: string; label: string; end?: boolean; premium?: boolean }[] = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/sets', label: 'Sets' },
  { to: '/cards', label: 'Cards' },
  { to: '/analytics', label: 'Analytics', premium: true },
  { to: '/alerts', label: 'Alerts', premium: true },
  { to: '/watchlist', label: 'Watchlist', premium: true },
  { to: '/signals', label: 'Buy Signals', premium: true },
  { to: '/track-record', label: 'Track Record', premium: true },
  { to: '/card-show', label: 'Card Show', premium: true },
]

function LockIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className={cn('size-3', className)}>
      <path fillRule="evenodd" d="M8 1a3.5 3.5 0 0 0-3.5 3.5V7A1.5 1.5 0 0 0 3 8.5v5A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 11.5 7V4.5A3.5 3.5 0 0 0 8 1Zm2 6V4.5a2 2 0 1 0-4 0V7h4Z" clipRule="evenodd" />
    </svg>
  )
}

function UpgradePopup({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div ref={ref} className="absolute left-1/2 top-full z-50 mt-2 w-64 -translate-x-1/2 rounded-xl border border-amber-500/30 bg-card p-4 shadow-xl">
      <div className="absolute -top-1.5 left-1/2 size-3 -translate-x-1/2 rotate-45 border-l border-t border-amber-500/30 bg-card" />
      <p className="text-sm font-semibold text-foreground">Premium Feature</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Upgrade for full access to all 172 sets and advanced analytics.
      </p>
      <Link
        to="/signals"
        onClick={(e) => { e.stopPropagation(); onClose() }}
        className="mt-3 block rounded-lg bg-amber-500 px-3 py-1.5 text-center text-xs font-semibold text-black transition-colors hover:bg-amber-400"
      >
        Upgrade to Premium
      </Link>
    </div>
  )
}

export function Layout() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getStoredThemeMode())
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [upgradePopupTab, setUpgradePopupTab] = useState<string | null>(null)
  const location = useLocation()
  const { user, logout } = useAuth()
  const isFree = user?.role === 'free'

  useEffect(() => {
    applyThemeMode(themeMode)
    setStoredThemeMode(themeMode)
  }, [themeMode])

  useEffect(() => {
    setMobileNavOpen(false)
    setUpgradePopupTab(null)
  }, [location.pathname])


  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-card/90 backdrop-blur supports-[backdrop-filter]:bg-card/75">
        <div className="mx-auto flex max-w-7xl flex-col gap-1.5 px-4 py-2 sm:gap-2 sm:py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
                aria-label={mobileNavOpen ? 'Close menu' : 'Open menu'}
                onClick={() => setMobileNavOpen((o) => !o)}
              >
                {mobileNavOpen ? (
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-5"><line x1="4" x2="20" y1="12" y2="12" /><line x1="4" x2="20" y1="6" y2="6" /><line x1="4" x2="20" y1="18" y2="18" /></svg>
                )}
              </button>
              <Link to="/" className="text-lg font-semibold tracking-tight text-primary sm:text-xl">
                PokeGrails
              </Link>
            </div>
            <div className="flex items-center gap-2">
              <p className="hidden max-w-md text-xs text-muted-foreground lg:block">
                Pokémon TCG pricing signals, pull-cost vs demand, and buy links
              </p>
              <HelpMenuButton />
              {user && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {user.username}
                    {user.role === 'free' ? (
                      <span className="ml-1 rounded bg-amber-500/20 px-1 py-0.5 text-[10px] uppercase text-amber-400">
                        Free · 3 sets
                      </span>
                    ) : (
                      <span className="ml-1 rounded bg-primary/20 px-1 py-0.5 text-[10px] uppercase text-primary">
                        {user.role}
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={logout}
                    className="rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    Sign out
                  </button>
                </div>
              )}
              <div className="inline-flex items-center rounded-md border border-border bg-background p-0.5">
                {(['light', 'dark', 'pokemon', 'system'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={cn(
                      'rounded px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide transition-colors sm:px-2.5',
                      themeMode === m
                        ? 'bg-secondary text-secondary-foreground'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                    onClick={() => setThemeMode(m)}
                    aria-pressed={themeMode === m}
                    title={`Use ${m} theme`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Desktop nav — horizontal tabs */}
          <nav
            className="hidden gap-1 md:flex md:flex-wrap"
            aria-label="Main"
          >
            {tabs.map((t) => {
              const locked = isFree && t.premium
              if (locked) {
                return (
                  <div key={t.to} className="relative">
                    <button
                      type="button"
                      onClick={() => setUpgradePopupTab(upgradePopupTab === t.to ? null : t.to)}
                      className="flex shrink-0 items-center gap-1 rounded-md px-3 py-1.5 text-sm whitespace-nowrap text-muted-foreground/40 transition-colors hover:text-muted-foreground/60"
                    >
                      <LockIcon className="size-2.5" />
                      {t.label}
                    </button>
                    {upgradePopupTab === t.to && (
                      <UpgradePopup onClose={() => setUpgradePopupTab(null)} />
                    )}
                  </div>
                )
              }
              return (
                <NavLink
                  key={t.to}
                  to={t.to}
                  end={t.end}
                  className={({ isActive }) =>
                    cn(
                      'shrink-0 rounded-md px-3 py-1.5 text-sm transition-colors whitespace-nowrap',
                      isActive
                        ? 'bg-secondary font-medium text-secondary-foreground shadow-sm'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )
                  }
                >
                  {t.label}
                </NavLink>
              )
            })}
          </nav>

          {/* Mobile nav — dropdown panel */}
          {mobileNavOpen && (
            <nav
              className="flex flex-col gap-0.5 border-t border-border pt-2 md:hidden"
              aria-label="Main"
            >
              {tabs.map((t) => {
                const locked = isFree && t.premium
                if (locked) {
                  return (
                    <div key={t.to} className="relative">
                      <button
                        type="button"
                        onClick={() => setUpgradePopupTab(upgradePopupTab === t.to ? null : t.to)}
                        className="flex w-full items-center gap-1.5 rounded-md px-3 py-2.5 text-sm font-medium text-muted-foreground/40 transition-colors hover:text-muted-foreground/60"
                      >
                        <LockIcon className="size-2.5" />
                        {t.label}
                      </button>
                      {upgradePopupTab === t.to && (
                        <UpgradePopup onClose={() => setUpgradePopupTab(null)} />
                      )}
                    </div>
                  )
                }
                return (
                  <NavLink
                    key={t.to}
                    to={t.to}
                    end={t.end}
                    className={({ isActive }) =>
                      cn(
                        'rounded-md px-3 py-2.5 text-sm font-medium transition-colors',
                        isActive
                          ? 'bg-secondary text-secondary-foreground shadow-sm'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      )
                    }
                  >
                    {t.label}
                  </NavLink>
                )
              })}
            </nav>
          )}
        </div>
      </header>
      <main className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col px-3 py-4 sm:px-4 sm:py-6">
        <Outlet />
      </main>
      <footer className="border-t border-border py-3 text-center text-xs text-muted-foreground sm:py-4">
        <div className="flex items-center justify-center gap-3">
          <span>&copy; {new Date().getFullYear()} PokeGrails</span>
          <span className="text-border">·</span>
          <Link to="/privacy" className="hover:text-foreground hover:underline">Privacy</Link>
          <span className="text-border">·</span>
          <Link to="/terms" className="hover:text-foreground hover:underline">Terms</Link>
        </div>
        <p className="mt-1 text-[10px]">
          Not financial advice. All predictions are model-generated estimates.
        </p>
      </footer>
    </div>
  )
}
