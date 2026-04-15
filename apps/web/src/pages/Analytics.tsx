import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip,
  Line,
  CartesianGrid, Cell, PieChart, Pie, ComposedChart,
} from 'recharts'

const STALE_5M = 5 * 60_000

type ModelStatus = {
  name: string; model_id: string; last_run: string | null
  card_coverage: number; total_cards: number; status: string
}
type CompletedStep = { id: string; duration_ms: number }
type RunProgress = {
  running: boolean; current_model: string | null
  completed: CompletedStep[]; queued: string[]; total: number
  started_at: string | null; elapsed_ms: number
  finished_at: string | null; error: string | null
}
type Paginated<T> = { items: T[]; total: number }
type FeatureImportance = {
  features: { name: string; importance: number; interpretation: string }[]
  trained_at: string; card_count: number
}
type MomentumCard = {
  card_id: string; name: string; set_id: string | null; set_name: string | null
  card_number: string; rarity: string | null; image_url: string | null
  market_price: number; momentum_score: number; trend_direction: string
  price_change_30d_pct: number; spark_30d: number[]; confidence: number
}
type AnomalyEvent = {
  card_id: string; name: string; set_name: string | null; card_number: string
  rarity: string | null; market_price: number; date: string; price: number
  z_score: number; type: string; magnitude_pct: number; image_url: string | null
}
type ClusterData = {
  assignments: { card_id: string; name: string; cluster_id: number; archetype: string; archetype_color: string; confidence: number }[]
  profiles: { cluster_id: number; archetype: string; archetype_color: string; description: string; card_count: number; avg_price: number; avg_volatility: number; avg_growth: number }[]
}
type PCAResult = {
  components: { component_id: number; label: string; explained_variance: number; cumulative_variance: number; top_features: { name: string; loading: number }[] }[]
  total_variance_explained: number; card_count: number; feature_count: number; computed_at: string
}
type PairCardInfo = {
  id: string; name: string; set_name: string | null; card_number: string
  rarity: string | null; market_price: number; image_url: string | null
}
type CointegrationPair = {
  card_a: PairCardInfo; card_b: PairCardInfo
  card_a_id: string; card_a_name: string; card_b_id: string; card_b_name: string
  correlation: number; p_value_approx: number; relationship: string
}
type SupplyShockAlert = {
  card_id: string; name: string; set_name: string | null; card_number: string
  rarity: string | null; market_price: number; image_url: string | null
  supply_proxy: number; price_trend_pct: number; alert_level: string; explanation: string
}

const TABS = [
  { id: 'overview', label: 'Model Status' },
  { id: 'momentum', label: 'Momentum Watch' },
  { id: 'insights', label: 'Market Intelligence' },
  { id: 'anomalies', label: 'Market Events' },
  { id: 'clusters', label: 'Archetypes' },
  { id: 'supply', label: 'Supply Warnings' },
  { id: 'correlations', label: 'Correlated Movers' },
  { id: 'pca', label: 'Variance Analysis' },
] as const

type TabId = (typeof TABS)[number]['id']

function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-muted/50', className)} />
}

function PaginationControls({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage: (p: number) => void }) {
  const pages = Math.ceil(total / pageSize)
  if (pages <= 1) return null
  return (
    <div className="flex items-center justify-between pt-2">
      <p className="text-xs text-muted-foreground">{total} total</p>
      <div className="flex items-center gap-1">
        <button type="button" disabled={page === 0} onClick={() => onPage(page - 1)}
          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-40">
          Prev
        </button>
        <span className="px-2 text-xs tabular-nums text-muted-foreground">{page + 1} / {pages}</span>
        <button type="button" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}
          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-40">
          Next
        </button>
      </div>
    </div>
  )
}

type CardInfoProps = {
  name: string
  image_url?: string | null
  set_name?: string | null
  card_number?: string
  rarity?: string | null
  market_price?: number
  card_id?: string
  compact?: boolean
}

function CardInfoBadge({ name, image_url, set_name, card_number, rarity, market_price, card_id, compact }: CardInfoProps) {
  const searchUrl = card_id ? `/cards?q=${encodeURIComponent(name)}` : undefined
  return (
    <div className={cn('flex items-center gap-3', compact ? 'gap-2' : 'gap-3')}>
      {image_url ? (
        <img src={image_url} alt="" className={cn('rounded object-cover shrink-0', compact ? 'h-10 w-7' : 'h-14 w-10')} loading="lazy" />
      ) : (
        <div className={cn('flex items-center justify-center rounded bg-muted text-muted-foreground text-[10px] shrink-0', compact ? 'h-10 w-7' : 'h-14 w-10')}>?</div>
      )}
      <div className="min-w-0 flex-1">
        <p className={cn('font-semibold truncate', compact ? 'text-xs' : 'text-sm')}>{name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {set_name ?? 'Unknown Set'}
          {card_number ? ` · #${card_number}` : ''}
          {rarity ? ` · ${rarity}` : ''}
        </p>
        <div className="mt-0.5 flex items-center gap-2">
          {market_price != null && market_price > 0 && (
            <span className="text-xs font-medium">${market_price.toFixed(2)}</span>
          )}
          {searchUrl && (
            <Link
              to={searchUrl}
              className="text-[10px] font-medium text-primary hover:underline"
            >
              View in Cards →
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}

const BATCH_MODELS = new Set([
  'gradient-boost', 'random-forest', 'clustering', 'pca',
  'lstm-momentum', 'supply-shock', 'anomaly', 'cointegration',
])
const ON_DEMAND_MODELS = new Set(['timeseries', 'sentiment', 'bayesian'])

type OnDemandResult = {
  model: string
  data: Record<string, unknown> | null
  error: string | null
}

type CardSearchResult = {
  id: string; name: string; set_id: string | null; rarity: string | null
  image_url: string | null; market_price: number
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
}

function ModelStatusPanel() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['model-status'], queryFn: () => api<ModelStatus[]>('/api/models/status'), staleTime: STALE_5M })

  const [dismissedFinish, setDismissedFinish] = useState(false)
  const prevRunningRef = useRef(false)

  const { data: progress } = useQuery({
    queryKey: ['run-progress'],
    queryFn: () => api<RunProgress>('/api/models/progress'),
    refetchInterval: (query) => {
      const p = query.state.data
      if (p?.running) return 350
      if (p?.finished_at && !dismissedFinish) return 1000
      return false
    },
  })

  useEffect(() => {
    if (prevRunningRef.current && progress && !progress.running) {
      qc.invalidateQueries({ queryKey: ['model-status'] })
      setDismissedFinish(false)
    }
    prevRunningRef.current = progress?.running ?? false
  }, [progress?.running, qc])

  const runAll = useMutation({
    mutationFn: () => api('/api/models/run-all', { method: 'POST' }),
    onSuccess: () => {
      setDismissedFinish(false)
      qc.invalidateQueries({ queryKey: ['run-progress'] })
    },
  })
  const runOne = useMutation({
    mutationFn: (modelId: string) => api(`/api/models/run/${modelId}`, { method: 'POST' }),
    onSuccess: () => {
      setDismissedFinish(false)
      qc.invalidateQueries({ queryKey: ['run-progress'] })
    },
  })

  const [cardSearch, setCardSearch] = useState('')
  const [selectedCard, setSelectedCard] = useState<CardSearchResult | null>(null)
  const [onDemandResults, setOnDemandResults] = useState<OnDemandResult[]>([])
  const [onDemandRunning, setOnDemandRunning] = useState(false)
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const [debouncedSearch, setDebouncedSearch] = useState('')
  useEffect(() => {
    clearTimeout(searchDebounceRef.current)
    if (cardSearch.trim().length < 2) { setDebouncedSearch(''); return }
    searchDebounceRef.current = setTimeout(() => setDebouncedSearch(cardSearch.trim()), 300)
    return () => clearTimeout(searchDebounceRef.current)
  }, [cardSearch])

  const { data: searchResults } = useQuery({
    queryKey: ['card-search', debouncedSearch],
    queryFn: () => api<{ items: CardSearchResult[] }>(`/api/cards?q=${encodeURIComponent(debouncedSearch)}&limit=8&sort=market_price&order=desc`),
    enabled: debouncedSearch.length >= 2,
  })

  async function runOnDemand(card: CardSearchResult) {
    setSelectedCard(card)
    setCardSearch('')
    setDebouncedSearch('')
    setOnDemandResults([])
    setOnDemandRunning(true)

    const models = [
      { id: 'timeseries', label: 'Time-Series Forecast', url: `/api/models/timeseries/${card.id}` },
      { id: 'sentiment', label: 'Sentiment Analysis', url: `/api/models/sentiment/${card.id}` },
      { id: 'bayesian', label: 'Bayesian Estimator', url: `/api/models/bayesian/estimate/${card.id}` },
    ]

    const results: OnDemandResult[] = []
    for (const m of models) {
      try {
        const res = await api<Record<string, unknown>>(m.url)
        results.push({ model: m.label, data: res, error: (res as { error?: string }).error ?? null })
      } catch (e) {
        results.push({ model: m.label, data: null, error: String(e) })
      }
    }
    setOnDemandResults(results)
    setOnDemandRunning(false)
  }

  const busy = progress?.running ?? false
  const anyActive = busy || runAll.isPending || runOne.isPending
  const completedMap = new Map(progress?.completed.map(c => [c.id, c]) ?? [])
  const queuedSet = new Set(progress?.queued ?? [])
  const pctDone = progress && progress.total > 0
    ? Math.round((progress.completed.length / progress.total) * 100) : 0
  const justFinished = !busy && !dismissedFinish && progress?.finished_at && progress.completed.length > 0

  const batchModels = data?.filter(m => BATCH_MODELS.has(m.model_id))
  const onDemandModels = data?.filter(m => ON_DEMAND_MODELS.has(m.model_id))

  if (isLoading) return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 11 }, (_, i) => <Skeleton key={i} className="h-24" />)}</div>

  return (
    <div className="space-y-8">
      {/* ── Batch Models ─────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Batch Models</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Pre-trained across the full card catalog. Run individually or all at once.
            </p>
          </div>
          <button
            type="button"
            className={cn(
              'rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
              anyActive
                ? 'bg-muted text-muted-foreground'
                : 'bg-primary text-primary-foreground hover:bg-primary/90',
            )}
            disabled={anyActive}
            onClick={() => runAll.mutate()}
          >
            {runAll.isPending ? 'Starting…' : busy ? `Running ${progress?.completed.length ?? 0}/${progress?.total ?? 0}…` : 'Run All Models'}
          </button>
        </div>

        {busy && (
          <div className="space-y-3 rounded-lg border border-primary/20 bg-card p-4">
            <div className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <div className="size-2 animate-pulse rounded-full bg-primary" />
                <span className="font-medium">
                  {progress?.current_model
                    ? data?.find(m => m.model_id === progress.current_model)?.name ?? progress.current_model
                    : 'Preparing…'}
                </span>
              </div>
              <div className="flex items-center gap-3 text-muted-foreground">
                <span className="tabular-nums text-xs">{formatDuration(progress?.elapsed_ms ?? 0)}</span>
                <span className="tabular-nums font-medium">{progress?.completed.length ?? 0} / {progress?.total ?? 0}</span>
              </div>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                style={{ width: `${Math.max(pctDone, busy ? 2 : 0)}%` }}
              />
            </div>
            <div className="flex flex-wrap gap-1">
              {progress?.completed.map(step => (
                <span key={step.id} className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-500">
                  {data?.find(m => m.model_id === step.id)?.name ?? step.id}{' '}
                  <span className="opacity-70">{formatDuration(step.duration_ms)}</span>
                </span>
              ))}
              {progress?.current_model && (
                <span className="animate-pulse rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  {data?.find(m => m.model_id === progress.current_model)?.name ?? progress.current_model}…
                </span>
              )}
              {progress?.queued.map(id => (
                <span key={id} className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {data?.find(m => m.model_id === id)?.name ?? id}
                </span>
              ))}
            </div>
          </div>
        )}

        {justFinished && (
          <div className="flex items-center justify-between rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
            <div className="flex items-center gap-2">
              <span className="text-emerald-500">✓</span>
              <span className="text-sm font-medium text-emerald-500">
                All {progress.completed.length} models completed in {formatDuration(progress.elapsed_ms)}
              </span>
            </div>
            <button
              type="button"
              className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
              onClick={() => setDismissedFinish(true)}
            >
              Dismiss
            </button>
          </div>
        )}

        {progress?.error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{progress.error}</div>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {batchModels?.map(m => {
            const isCurrentlyRunning = progress?.current_model === m.model_id
            const completedStep = completedMap.get(m.model_id)
            const isQueued = queuedSet.has(m.model_id)
            const showDone = !!completedStep && (busy || justFinished)

            let cardState: 'running' | 'done' | 'queued' | 'ready' | 'not_run' | 'low_data'
            if (isCurrentlyRunning) cardState = 'running'
            else if (showDone) cardState = 'done'
            else if (isQueued && busy) cardState = 'queued'
            else if (m.status === 'ready') cardState = 'ready'
            else if (m.status === 'not_run') cardState = 'not_run'
            else cardState = 'low_data'

            const badgeStyles = {
              running: 'animate-pulse bg-primary/20 text-primary',
              done: 'bg-emerald-500/15 text-emerald-500',
              queued: 'bg-blue-500/15 text-blue-400',
              ready: 'bg-emerald-500/15 text-emerald-500',
              not_run: 'bg-amber-500/15 text-amber-500',
              low_data: 'bg-red-500/15 text-red-400',
            }
            const badgeLabels = {
              running: 'Running',
              done: completedStep ? formatDuration(completedStep.duration_ms) : 'Done',
              queued: 'Queued',
              ready: 'Ready',
              not_run: 'Not Run',
              low_data: 'Low Data',
            }
            const borderStyles = {
              running: 'border-primary/50 ring-1 ring-primary/30',
              done: 'border-emerald-500/30',
              queued: 'border-blue-500/20',
              ready: 'border-border',
              not_run: 'border-border',
              low_data: 'border-border',
            }

            return (
              <div key={m.model_id} className={cn(
                'rounded-lg border bg-card p-4 transition-all duration-200',
                borderStyles[cardState],
              )}>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-sm font-medium">{m.name}</h3>
                  <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide', badgeStyles[cardState])}>
                    {badgeLabels[cardState]}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {m.card_coverage.toLocaleString()} / {m.total_cards.toLocaleString()} cards
                </p>
                {m.last_run && (
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    Last: {new Date(m.last_run).toLocaleString()}
                  </p>
                )}
                {isCurrentlyRunning && (
                  <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
                    <div className="h-full w-1/3 animate-[slide_1s_ease-in-out_infinite] rounded-full bg-primary" />
                  </div>
                )}
                {cardState === 'done' && (
                  <div className="mt-2 h-1 rounded-full bg-emerald-500/30">
                    <div className="h-full w-full rounded-full bg-emerald-500" />
                  </div>
                )}
                {!anyActive && (
                  <button
                    type="button"
                    className="mt-2 w-full rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    onClick={() => runOne.mutate(m.model_id)}
                  >
                    Run
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </section>

      {/* ── On-Demand Models ─────────────────────── */}
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">On-Demand Models</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            These models analyze a single card instantly. Search for a card below to run all three.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          {onDemandModels?.map(m => (
            <div key={m.model_id} className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-sm font-medium">{m.name}</h3>
                <span className="shrink-0 rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-400">Per Card</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {m.card_coverage.toLocaleString()} / {m.total_cards.toLocaleString()} cards eligible
              </p>
            </div>
          ))}
        </div>

        <div className="relative">
          <input
            type="text"
            value={cardSearch}
            onChange={e => { setCardSearch(e.target.value); setSelectedCard(null); setOnDemandResults([]) }}
            placeholder="Search for a card by name to run on-demand models..."
            className="w-full rounded-lg border border-border bg-card px-4 py-2.5 text-sm outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary focus:ring-1 focus:ring-primary/30"
          />
          {debouncedSearch && searchResults?.items?.length ? (
            <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-80 overflow-auto rounded-lg border border-border bg-card shadow-xl">
              {searchResults.items.map(card => (
                <button
                  key={card.id}
                  type="button"
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted"
                  onClick={() => runOnDemand(card)}
                >
                  {card.image_url && <img src={card.image_url} alt="" className="h-10 w-7 rounded object-cover" loading="lazy" />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{card.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {card.set_id}{card.rarity ? ` · ${card.rarity}` : ''} · ${card.market_price?.toFixed(2) ?? '?'}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {selectedCard && (
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-3">
              {selectedCard.image_url && <img src={selectedCard.image_url} alt="" className="h-16 w-12 rounded object-cover" />}
              <div>
                <h3 className="text-sm font-semibold">{selectedCard.name}</h3>
                <p className="text-xs text-muted-foreground">{selectedCard.set_id}{selectedCard.rarity ? ` · ${selectedCard.rarity}` : ''} · ${selectedCard.market_price?.toFixed(2)}</p>
              </div>
            </div>

            {onDemandRunning && (
              <div className="mt-4 space-y-2">
                <p className="text-sm font-medium text-muted-foreground">Running models...</p>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full w-1/3 animate-[slide_1.5s_ease-in-out_infinite] rounded-full bg-primary" />
                </div>
              </div>
            )}

            {onDemandResults.length > 0 && (
              <div className="mt-4 space-y-3">
                {onDemandResults.map(r => (
                  <div key={r.model} className={cn('rounded-lg border p-3', r.error ? 'border-red-500/30 bg-red-500/5' : 'border-border bg-card/50')}>
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-semibold">{r.model}</h4>
                      <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium',
                        r.error ? 'bg-red-500/15 text-red-400' : 'bg-emerald-500/15 text-emerald-500'
                      )}>
                        {r.error ? 'Error' : 'Success'}
                      </span>
                    </div>
                    {r.error ? (
                      <p className="mt-1 text-xs text-red-400">{r.error}</p>
                    ) : r.data ? (
                      <OnDemandResultSummary model={r.model} data={r.data} />
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Price history is sourced from TCGPlayer and PriceCharting snapshots — newer sets may have limited data until enough snapshots accumulate.
        </p>
      </section>
    </div>
  )
}

function OnDemandResultSummary({ model, data }: { model: string; data: Record<string, unknown> }) {
  if (model === 'Time-Series Forecast') {
    const forecast = data.forecast as { date: string; price: number }[] | undefined
    const method = data.method as string | undefined
    if (!forecast?.length) return <p className="mt-1 text-xs text-muted-foreground">No forecast available.</p>
    const last = forecast[forecast.length - 1]
    const first = forecast[0]
    const change = first.price > 0 ? ((last.price - first.price) / first.price * 100) : 0
    return (
      <div className="mt-2 space-y-1 text-xs">
        <p><span className="text-muted-foreground">Method:</span> {method}</p>
        <p><span className="text-muted-foreground">{forecast.length}-day forecast:</span>{' '}
          <span className="font-medium">${first.price.toFixed(2)}</span> → <span className="font-medium">${last.price.toFixed(2)}</span>
          <span className={cn('ml-1', change > 0 ? 'text-emerald-500' : 'text-red-400')}>({change > 0 ? '+' : ''}{change.toFixed(1)}%)</span>
        </p>
      </div>
    )
  }

  if (model === 'Sentiment Analysis') {
    const score = data.sentiment_score as number | undefined
    const label = data.label as string | undefined
    const signals = data.signals as string[] | undefined
    const breakdown = data.breakdown as { source: string; score: number; detail: string }[] | undefined
    return (
      <div className="mt-2 space-y-2 text-xs">
        <p><span className="text-muted-foreground">Signal:</span>{' '}
          <span className={cn('font-semibold', label === 'positive' ? 'text-emerald-500' : label === 'negative' ? 'text-red-400' : 'text-amber-400')}>
            {label === 'positive' ? 'Bullish' : label === 'negative' ? 'Bearish' : 'Neutral'}
          </span>
          {score != null && <span className="ml-1 text-muted-foreground">(composite: {score.toFixed(3)})</span>}
        </p>
        {breakdown?.length ? (
          <div className="space-y-1">
            {breakdown.map(b => (
              <div key={b.source} className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">{b.source}</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground">{b.detail}</span>
                  <span className={cn('min-w-[3rem] text-right font-medium tabular-nums',
                    b.score > 0.1 ? 'text-emerald-500' : b.score < -0.1 ? 'text-red-400' : 'text-muted-foreground'
                  )}>
                    {b.score > 0 ? '+' : ''}{b.score.toFixed(2)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {signals?.length ? (
          <div className="flex flex-wrap gap-1 pt-1">
            {signals.map((s, i) => (
              <span key={i} className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium',
                s.startsWith('Positive') || s.startsWith('High') || s.startsWith('Strong') || s.includes('bullish')
                  ? 'bg-emerald-500/15 text-emerald-500'
                  : s.startsWith('Negative') || s.startsWith('Low') || s.includes('bearish')
                    ? 'bg-red-500/15 text-red-400'
                    : 'bg-muted text-muted-foreground'
              )}>
                {s}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    )
  }

  if (model === 'Bayesian Estimator') {
    const est = data.estimated_price as number | undefined
    const market = data.market_price as number | undefined
    const ciLow = data.credible_interval_low as number | undefined
    const ciHigh = data.credible_interval_high as number | undefined
    const prior = data.prior_source as string | undefined
    const priorMean = data.prior_mean as number | null | undefined
    const numObs = data.num_observations as number | undefined
    const confidence = data.confidence_label as string | undefined

    const gap = est && market && market > 0 ? ((est - market) / market * 100) : null
    const withinCI = ciLow != null && ciHigh != null && market ? market >= ciLow && market <= ciHigh : null

    return (
      <div className="mt-2 space-y-2 text-xs">
        <div className="flex items-center gap-4">
          <div>
            <span className="text-muted-foreground">Fair Value Estimate</span>
            <p className="text-base font-bold">${est?.toFixed(2) ?? '?'}</p>
          </div>
          {market != null && market > 0 && (
            <div>
              <span className="text-muted-foreground">Market Price</span>
              <p className="text-base font-bold">${market.toFixed(2)}</p>
            </div>
          )}
          {gap != null && (
            <div>
              <span className="text-muted-foreground">Gap</span>
              <p className={cn('text-sm font-bold', gap > 0 ? 'text-emerald-500' : 'text-red-400')}>
                {gap > 0 ? '+' : ''}{gap.toFixed(1)}%
              </p>
            </div>
          )}
        </div>
        {ciLow != null && ciHigh != null && (
          <p><span className="text-muted-foreground">95% Credible Interval:</span>{' '}
            <span className="font-medium tabular-nums">${ciLow.toFixed(2)} – ${ciHigh.toFixed(2)}</span>
            {withinCI != null && (
              <span className={cn('ml-1', withinCI ? 'text-emerald-500' : 'text-amber-400')}>
                {withinCI ? '(market price within range)' : '(market price outside range)'}
              </span>
            )}
          </p>
        )}
        {confidence && <p className="text-muted-foreground">{confidence}</p>}
        {gap != null && Math.abs(gap) > 20 && (
          <p className={cn('rounded-md px-2 py-1 text-[11px]',
            gap > 20 ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'
          )}>
            {gap > 20
              ? 'Model suggests this card may be undervalued relative to peers and recent trends.'
              : 'Model suggests the current price exceeds the estimated fair value. The card may have appreciated faster than comparable cards, or demand may be outpacing historical patterns.'}
          </p>
        )}
        <div className="rounded-md border border-border/50 bg-muted/30 p-2 space-y-0.5">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">How this was calculated</p>
          {prior && <p><span className="text-muted-foreground">Peer group:</span> {prior}</p>}
          {priorMean != null && (
            <p><span className="text-muted-foreground">Peer group avg price:</span>{' '}
              <span className="font-medium">${priorMean.toFixed(2)}</span>
            </p>
          )}
          {numObs != null && (
            <p><span className="text-muted-foreground">Price history points:</span>{' '}
              <span className="font-medium">{numObs}</span>
              <span className="text-muted-foreground"> (recent prices weighted more heavily)</span>
            </p>
          )}
        </div>
      </div>
    )
  }

  return <pre className="mt-1 max-h-32 overflow-auto text-[10px] text-muted-foreground">{JSON.stringify(data, null, 2)}</pre>
}

const MOMENTUM_PAGE_SIZE = 15

function MomentumPanel() {
  const [page, setPage] = useState(0)
  const { data, isLoading } = useQuery({
    queryKey: ['momentum-cards'],
    queryFn: () => api<Paginated<MomentumCard>>('/api/models/momentum/cards?limit=200'),
    staleTime: STALE_5M,
  })

  if (isLoading) return <div className="space-y-3">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-20" />)}</div>
  const items = data?.items ?? []
  const total = data?.total ?? 0
  if (!items.length) return <p className="text-sm text-muted-foreground">No cards currently in a momentum phase. Check back after more price data accumulates.</p>

  const pageItems = items.slice(page * MOMENTUM_PAGE_SIZE, (page + 1) * MOMENTUM_PAGE_SIZE)

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Momentum Watch</h2>
      <p className="text-sm text-muted-foreground">Cards showing accelerating price patterns that historically precede significant moves.</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {pageItems.map(card => (
          <div key={card.card_id} className={cn('rounded-lg border border-border bg-card p-4 transition-shadow', card.momentum_score >= 75 && 'ring-2 ring-amber-500/50 shadow-lg shadow-amber-500/10')}>
            <CardInfoBadge
              name={card.name}
              image_url={card.image_url}
              set_name={card.set_name ?? card.set_id}
              card_number={card.card_number}
              rarity={card.rarity}
              market_price={card.market_price}
              card_id={card.card_id}
            />
            <div className="mt-3 space-y-1.5">
              <div className="flex items-center gap-2">
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-gradient-to-r from-amber-500 to-red-500 transition-all" style={{ width: `${card.momentum_score}%` }} />
                </div>
                <span className="text-xs font-bold tabular-nums">{card.momentum_score}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={cn('text-xs font-medium', card.price_change_30d_pct > 0 ? 'text-emerald-500' : 'text-red-400')}>
                  {card.price_change_30d_pct > 0 ? '▲' : '▼'} {Math.abs(card.price_change_30d_pct).toFixed(1)}%
                </span>
                <span className="text-[10px] text-muted-foreground">{card.trend_direction}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
      <PaginationControls page={page} total={total} pageSize={MOMENTUM_PAGE_SIZE} onPage={setPage} />
    </div>
  )
}

function MarketIntelligencePanel() {
  const { data, isLoading } = useQuery({ queryKey: ['feature-importance'], queryFn: () => api<FeatureImportance>('/api/models/random-forest/feature-importance'), staleTime: STALE_5M })

  if (isLoading) return <Skeleton className="h-80" />
  if (!data?.features?.length) return <p className="text-sm text-muted-foreground">Insufficient card data to compute feature importance.</p>

  const chartData = data.features.slice(0, 10).map(f => ({
    name: f.name.replace(/_/g, ' '),
    importance: Math.round(f.importance * 100),
    interpretation: f.interpretation,
  }))

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">What Drives Pokemon Card Value?</h2>
      <p className="text-sm text-muted-foreground">Global feature importance across {data.card_count.toLocaleString()} cards — which attributes best predict price.</p>
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} layout="vertical" margin={{ left: 120, right: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis type="number" domain={[0, 'auto']} tickFormatter={v => `${v}%`} tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }} />
            <YAxis type="category" dataKey="name" tick={{ fill: 'var(--color-foreground)', fontSize: 12 }} width={110} />
            <Tooltip
              contentStyle={{ background: 'var(--color-card)', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 12 }}
              formatter={(value: unknown, _name: unknown, entry: { payload?: { interpretation?: string } }) => [`${Number(value)}%`, entry?.payload?.interpretation ?? '']}
            />
            <Bar dataKey="importance" radius={[0, 4, 4, 0]}>
              {chartData.map((_, i) => (
                <Cell key={i} fill={`oklch(0.72 0.19 ${145 + i * 22})`} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="space-y-2">
        {data.features.slice(0, 5).map(f => (
          <div key={f.name} className="rounded-md border border-border bg-card/50 p-3">
            <p className="text-xs">
              <span className="font-semibold">{f.name.replace(/_/g, ' ')}:</span>{' '}
              <span className="text-muted-foreground">{f.interpretation}</span>
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}

const ANOMALY_PAGE_SIZE = 30

function AnomaliesPanel() {
  const [page, setPage] = useState(0)
  const { data, isLoading } = useQuery({
    queryKey: ['anomalies-recent'],
    queryFn: () => api<Paginated<AnomalyEvent>>('/api/models/anomalies/recent?limit=100'),
    staleTime: STALE_5M,
  })

  if (isLoading) return <div className="space-y-3">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-16" />)}</div>
  const items = data?.items ?? []
  const total = data?.total ?? 0
  if (!items.length) return <p className="text-sm text-muted-foreground">No anomalous price events detected in the last 30 days.</p>

  const typeColors: Record<string, string> = { pump: 'text-emerald-500', crash: 'text-red-400', recovery: 'text-blue-400' }
  const typeIcons: Record<string, string> = { pump: '▲', crash: '▼', recovery: '↻' }
  const pageItems = items.slice(page * ANOMALY_PAGE_SIZE, (page + 1) * ANOMALY_PAGE_SIZE)

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Market Events</h2>
      <p className="text-sm text-muted-foreground">Statistically significant price anomalies detected via z-score analysis.</p>
      <div className="divide-y divide-border rounded-lg border border-border bg-card">
        {pageItems.map((event, i) => (
          <div key={`${event.card_id}-${event.date}-${i}`} className="flex items-center gap-3 px-4 py-3">
            <span className={cn('text-xl font-bold shrink-0', typeColors[event.type] ?? 'text-muted-foreground')}>
              {typeIcons[event.type] ?? '•'}
            </span>
            <div className="min-w-0 flex-1">
              <CardInfoBadge
                name={event.name}
                image_url={event.image_url}
                set_name={event.set_name}
                card_number={event.card_number}
                rarity={event.rarity}
                market_price={event.market_price}
                card_id={event.card_id}
                compact
              />
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                <span>{event.date}</span>
                <span>Event price: <strong className="text-foreground">${event.price.toFixed(2)}</strong></span>
                <span>z-score: <strong className={cn(event.z_score > 0 ? 'text-emerald-500' : 'text-red-400')}>{event.z_score}</strong></span>
                <span>{event.magnitude_pct}% move</span>
              </div>
            </div>
            <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase',
              event.type === 'pump' ? 'bg-emerald-500/15 text-emerald-500' :
              event.type === 'crash' ? 'bg-red-500/15 text-red-400' :
              'bg-blue-500/15 text-blue-400'
            )}>
              {event.type}
            </span>
          </div>
        ))}
      </div>
      <PaginationControls page={page} total={total} pageSize={ANOMALY_PAGE_SIZE} onPage={setPage} />
    </div>
  )
}

function ClustersPanel() {
  const { data, isLoading } = useQuery({ queryKey: ['clusters'], queryFn: () => api<ClusterData>('/api/models/clusters/all'), staleTime: STALE_5M })

  if (isLoading) return <Skeleton className="h-80" />
  if (!data?.profiles?.length) return <p className="text-sm text-muted-foreground">Insufficient data for clustering. Need at least 10 cards.</p>

  const pieData = data.profiles.map(p => ({ name: p.archetype, value: p.card_count, fill: p.archetype_color }))

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Portfolio by Archetype</h2>
      <p className="text-sm text-muted-foreground">Cards automatically segmented into behavioral archetypes using k-means clustering.</p>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100} strokeWidth={2} stroke="var(--color-card)">
                {pieData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
              </Pie>
              <Tooltip contentStyle={{ background: 'var(--color-card)', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="space-y-3">
          {data.profiles.map(p => (
            <div key={p.cluster_id} className="rounded-lg border border-border bg-card p-3">
              <div className="flex items-center gap-2">
                <div className="size-3 rounded-full" style={{ backgroundColor: p.archetype_color }} />
                <h3 className="text-sm font-semibold">{p.archetype}</h3>
                <span className="text-xs text-muted-foreground">({p.card_count} cards)</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{p.description}</p>
              <div className="mt-1.5 flex gap-4 text-xs">
                <span>Avg: <strong>${p.avg_price.toFixed(2)}</strong></span>
                <span>Vol: <strong>{(p.avg_volatility * 100).toFixed(0)}%</strong></span>
                <span className={p.avg_growth > 0 ? 'text-emerald-500' : 'text-red-400'}>
                  Growth: <strong>{(p.avg_growth * 100).toFixed(1)}%</strong>
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const SUPPLY_PAGE_SIZE = 30

function SupplyPanel() {
  const [page, setPage] = useState(0)
  const { data, isLoading } = useQuery({
    queryKey: ['supply-shock'],
    queryFn: () => api<Paginated<SupplyShockAlert>>('/api/models/supply-shock/alerts?limit=100'),
    staleTime: STALE_5M,
  })

  if (isLoading) return <div className="space-y-3">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-16" />)}</div>
  const items = data?.items ?? []
  const total = data?.total ?? 0
  if (!items.length) return <p className="text-sm text-muted-foreground">No supply shock signals detected. Market supply appears stable.</p>

  const levelColors: Record<string, string> = { high: 'bg-red-500/15 text-red-400', medium: 'bg-amber-500/15 text-amber-500', low: 'bg-yellow-500/15 text-yellow-500' }
  const pageItems = items.slice(page * SUPPLY_PAGE_SIZE, (page + 1) * SUPPLY_PAGE_SIZE)

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Supply Warnings</h2>
      <p className="text-sm text-muted-foreground">Cards showing supply pressure that may suppress prices. Based on price trajectory, eBay spreads, and rarity signals.</p>
      <div className="divide-y divide-border rounded-lg border border-border bg-card">
        {pageItems.map(alert => (
          <div key={alert.card_id} className="flex items-center gap-3 px-4 py-3">
            <span className="text-lg shrink-0">⚠️</span>
            <div className="min-w-0 flex-1">
              <CardInfoBadge
                name={alert.name}
                image_url={alert.image_url}
                set_name={alert.set_name}
                card_number={alert.card_number}
                rarity={alert.rarity}
                market_price={alert.market_price}
                card_id={alert.card_id}
                compact
              />
              <p className="mt-1.5 text-xs text-muted-foreground">{alert.explanation}</p>
              <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                <span>Supply index: <strong className="text-foreground">{alert.supply_proxy}</strong></span>
                <span className={cn(alert.price_trend_pct < 0 ? 'text-red-400' : 'text-emerald-500')}>
                  Trend: {alert.price_trend_pct > 0 ? '+' : ''}{alert.price_trend_pct.toFixed(1)}%
                </span>
              </div>
            </div>
            <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase', levelColors[alert.alert_level] ?? levelColors.low)}>
              {alert.alert_level}
            </span>
          </div>
        ))}
      </div>
      <PaginationControls page={page} total={total} pageSize={SUPPLY_PAGE_SIZE} onPage={setPage} />
    </div>
  )
}

const CORR_PAGE_SIZE = 20

function CorrelationsPanel() {
  const [page, setPage] = useState(0)
  const { data, isLoading } = useQuery({
    queryKey: ['cointegration'],
    queryFn: () => api<Paginated<CointegrationPair>>('/api/models/cointegration/pairs?limit=100'),
    staleTime: STALE_5M,
  })

  if (isLoading) return <div className="space-y-3">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-16" />)}</div>
  const items = data?.items ?? []
  const total = data?.total ?? 0
  if (!items.length) return <p className="text-sm text-muted-foreground">No strongly correlated card pairs found. Need more overlapping price history.</p>

  const relColors: Record<string, string> = { strong: 'bg-emerald-500/15 text-emerald-500', moderate: 'bg-blue-500/15 text-blue-400', weak: 'bg-muted text-muted-foreground' }
  const pageItems = items.slice(page * CORR_PAGE_SIZE, (page + 1) * CORR_PAGE_SIZE)

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Correlated Movers</h2>
      <p className="text-sm text-muted-foreground">Card pairs that historically move together — if one spikes, the other tends to follow.</p>
      <div className="space-y-3">
        {pageItems.map((pair, i) => (
          <div key={`${pair.card_a_id}-${pair.card_b_id}-${i}`} className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Correlation:</span>
                <span className="text-sm font-bold tabular-nums">{pair.correlation.toFixed(3)}</span>
                <span className="text-xs text-muted-foreground">p≈{pair.p_value_approx.toFixed(4)}</span>
              </div>
              <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase', relColors[pair.relationship] ?? relColors.weak)}>
                {pair.relationship}
              </span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-md border border-border/50 bg-card/50 p-3">
                <CardInfoBadge
                  name={pair.card_a.name}
                  image_url={pair.card_a.image_url}
                  set_name={pair.card_a.set_name}
                  card_number={pair.card_a.card_number}
                  rarity={pair.card_a.rarity}
                  market_price={pair.card_a.market_price}
                  card_id={pair.card_a.id}
                  compact
                />
              </div>
              <div className="rounded-md border border-border/50 bg-card/50 p-3">
                <CardInfoBadge
                  name={pair.card_b.name}
                  image_url={pair.card_b.image_url}
                  set_name={pair.card_b.set_name}
                  card_number={pair.card_b.card_number}
                  rarity={pair.card_b.rarity}
                  market_price={pair.card_b.market_price}
                  card_id={pair.card_b.id}
                  compact
                />
              </div>
            </div>
          </div>
        ))}
      </div>
      <PaginationControls page={page} total={total} pageSize={CORR_PAGE_SIZE} onPage={setPage} />
    </div>
  )
}

function PCAPanel() {
  const { data, isLoading } = useQuery({ queryKey: ['pca-components'], queryFn: () => api<PCAResult>('/api/models/pca/components'), staleTime: STALE_5M })

  if (isLoading) return <Skeleton className="h-80" />
  if (!data?.components?.length) return <p className="text-sm text-muted-foreground">Insufficient data for PCA analysis.</p>

  const chartData = data.components.map(c => ({
    name: `PC${c.component_id}`,
    explained: Math.round(c.explained_variance * 100),
    cumulative: Math.round(c.cumulative_variance * 100),
  }))

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Variance Explained</h2>
      <p className="text-sm text-muted-foreground">
        Principal Component Analysis across {data.card_count.toLocaleString()} cards and {data.feature_count} features.
        Total variance captured: {(data.total_variance_explained * 100).toFixed(1)}%.
      </p>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ left: 10, right: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis dataKey="name" tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }} />
            <YAxis tickFormatter={v => `${v}%`} tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }} />
            <Tooltip contentStyle={{ background: 'var(--color-card)', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 12 }} />
            <Bar dataKey="explained" name="Explained %" fill="var(--color-chart-1)" radius={[4, 4, 0, 0]} />
            <Line type="monotone" dataKey="cumulative" name="Cumulative %" stroke="var(--color-chart-2)" strokeWidth={2} dot />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="space-y-2">
        {data.components.slice(0, 5).map(c => (
          <div key={c.component_id} className="rounded-md border border-border bg-card/50 p-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold">{c.label}</h3>
              <span className="text-xs text-muted-foreground">{(c.explained_variance * 100).toFixed(1)}% variance</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {c.top_features.map(f => (
                <span key={f.name} className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {f.name.replace(/_/g, ' ')} ({(f.loading * 100).toFixed(0)}%)
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function AnalyticsPage() {
  const [tab, setTab] = useState<TabId>('overview')

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Advanced predictive models and market intelligence — all computed in real time from your card data.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            className={cn(
              'rounded-md px-3 py-1.5 text-sm transition-colors whitespace-nowrap',
              tab === t.id
                ? 'bg-secondary font-medium text-secondary-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-[400px]">
        {tab === 'overview' && <ModelStatusPanel />}
        {tab === 'momentum' && <MomentumPanel />}
        {tab === 'insights' && <MarketIntelligencePanel />}
        {tab === 'anomalies' && <AnomaliesPanel />}
        {tab === 'clusters' && <ClustersPanel />}
        {tab === 'supply' && <SupplyPanel />}
        {tab === 'correlations' && <CorrelationsPanel />}
        {tab === 'pca' && <PCAPanel />}
      </div>
    </div>
  )
}
