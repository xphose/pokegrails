import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface BackfillStatus {
  running: boolean
  phase: 'idle' | 'phase1-match' | 'phase2-meta' | 'phase3-chart' | 'phase4-sealed' | 'complete' | 'failed'
  phaseProgress: { current: number; total: number }
  startedAt: number | null
  finishedAt: number | null
  lastError: string | null
  lastStats: {
    cardsMatched: number
    cardsScraped: number
    sealedScraped: number
    errors: number
    gradeHistoryRows?: number
  } | null
  scope: string
  durable: {
    cardsTotal: number
    cardsMatched: number
    cardsUnmatched: number
    cardsWithHistory: number
    percentMatched: number
    percentScraped: number
    pcHistoryRows: number
    latestPcTimestamp: string | null
  }
}

const PHASE_LABEL: Record<BackfillStatus['phase'], string> = {
  idle: 'Idle',
  'phase1-match': 'Phase 1 — Matching cards to PriceCharting products',
  'phase2-meta': 'Phase 2 — Fetching metadata for previously-matched cards',
  'phase3-chart': 'Phase 3 — Scraping price charts',
  'phase4-sealed': 'Phase 4 — Scraping sealed product history',
  complete: 'Complete',
  failed: 'Failed',
}

const POLL_INTERVAL_MS = 10_000

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`
}
function fmtAge(ts: string | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  const ageSec = Math.round((Date.now() - d.getTime()) / 1000)
  if (ageSec < 60) return `${ageSec}s ago`
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m ago`
  if (ageSec < 86_400) return `${Math.round(ageSec / 3600)}h ago`
  return `${Math.round(ageSec / 86_400)}d ago`
}
function fmtRelative(ms: number | null): string {
  if (!ms) return '—'
  return fmtAge(new Date(ms).toISOString())
}

/**
 * Admin-only PriceCharting backfill dashboard panel. Polls
 * `/api/internal/backfill-pricecharting/status` so an operator can
 * watch progress without SSH'ing to read server logs. The durable
 * counts come straight from the DB so even after a restart the panel
 * shows meaningful numbers.
 *
 * The start button posts to the existing `/api/internal/backfill-
 * pricecharting` endpoint. A 409 response means a job is already
 * running on this node — we surface that as a friendly message rather
 * than an error. Force-mode re-scrapes cards that already have ≥6 PC
 * history rows (useful when we suspect contamination in older rows).
 */
export function AdminBackfillPanel() {
  const [status, setStatus] = useState<BackfillStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [startMessage, setStartMessage] = useState<string | null>(null)
  const [force, setForce] = useState(false)
  const [skipSealed, setSkipSealed] = useState(false)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await api<{ ok: boolean; status: BackfillStatus }>(
        '/api/internal/backfill-pricecharting/status',
      )
      setStatus(res.status)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch status')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchStatus()
    const id = window.setInterval(() => {
      void fetchStatus()
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [fetchStatus])

  const handleStart = useCallback(async () => {
    const prompt = force
      ? 'Start FORCE backfill? This re-scrapes cards that already have history (slower, 6+ hours).'
      : 'Start PriceCharting backfill? This runs for several hours against the live API.'
    if (!window.confirm(prompt)) return
    setStarting(true)
    setStartMessage(null)
    try {
      const params = new URLSearchParams()
      if (force) params.set('force', '1')
      if (skipSealed) params.set('skipSealed', '1')
      const query = params.toString() ? `?${params.toString()}` : ''
      const res = await api<{ ok: boolean; message?: string; error?: string }>(
        `/api/internal/backfill-pricecharting${query}`,
        { method: 'POST' },
      )
      setStartMessage(res.message ?? 'Backfill started.')
      void fetchStatus()
    } catch (e) {
      setStartMessage(e instanceof Error ? e.message : 'Failed to start backfill')
    } finally {
      setStarting(false)
    }
  }, [force, skipSealed, fetchStatus])

  const phaseBar = useMemo(() => {
    if (!status) return null
    const { current, total } = status.phaseProgress
    const pct = total > 0 ? (current / total) * 100 : 0
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{PHASE_LABEL[status.phase]}</span>
          <span>
            {current}/{total}
            {total > 0 ? ` (${pct.toFixed(1)}%)` : ''}
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded bg-muted">
          <div
            className={cn(
              'h-full transition-all',
              status.phase === 'failed' ? 'bg-red-500' : 'bg-primary',
            )}
            style={{ width: `${Math.min(100, pct)}%` }}
            aria-label="phase progress"
          />
        </div>
      </div>
    )
  }, [status])

  if (loading && !status) {
    return (
      <section className="rounded-lg border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
        Loading PriceCharting backfill status…
      </section>
    )
  }

  if (error && !status) {
    return (
      <section className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
        Failed to load backfill status: {error}
      </section>
    )
  }

  if (!status) return null

  const { durable } = status

  return (
    <section className="space-y-3 rounded-lg border border-border bg-muted/20 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">PriceCharting Backfill (admin)</h2>
          <p className="text-xs text-muted-foreground">
            Populates `cards.pricecharting_id`, graded-price columns, and per-card price history
            from the PriceCharting API. Runs serially; full-catalog passes take 6+ hours.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={force}
              onChange={(e) => setForce(e.target.checked)}
              disabled={status.running || starting}
            />
            Force re-scrape
          </label>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={skipSealed}
              onChange={(e) => setSkipSealed(e.target.checked)}
              disabled={status.running || starting}
            />
            Skip sealed
          </label>
          <Button
            type="button"
            size="sm"
            variant={status.running ? 'secondary' : 'default'}
            onClick={handleStart}
            disabled={status.running || starting}
          >
            {status.running ? 'Running…' : starting ? 'Starting…' : 'Start backfill'}
          </Button>
        </div>
      </header>

      {phaseBar}

      <div className="grid gap-2 text-xs sm:grid-cols-2 md:grid-cols-4">
        <MetricBox label="Matched" value={`${durable.cardsMatched.toLocaleString()} / ${durable.cardsTotal.toLocaleString()}`} subtitle={fmtPct(durable.percentMatched)} />
        <MetricBox label="With history" value={durable.cardsWithHistory.toLocaleString()} subtitle={`${fmtPct(durable.percentScraped)} of matched`} />
        <MetricBox label="PC history rows" value={durable.pcHistoryRows.toLocaleString()} subtitle={`last tick ${fmtAge(durable.latestPcTimestamp)}`} />
        <MetricBox label="Last run" value={status.lastStats ? `${status.lastStats.cardsScraped} scraped` : '—'} subtitle={`${fmtRelative(status.finishedAt)} · scope ${status.scope}`} />
      </div>

      {status.lastError && (
        <p className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-xs text-red-400">
          Last error: {status.lastError}
        </p>
      )}
      {startMessage && (
        <p className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-300">
          {startMessage}
        </p>
      )}
    </section>
  )
}

function MetricBox({ label, value, subtitle }: { label: string; value: string; subtitle?: string }) {
  return (
    <div className="rounded border border-border/60 bg-background/50 p-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-semibold">{value}</div>
      {subtitle && <div className="text-[11px] text-muted-foreground">{subtitle}</div>}
    </div>
  )
}
