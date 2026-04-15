import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { formatPctAxis } from '@/lib/chart-format'
import { HelpButton } from '@/components/help-center'
import { loadTrackRecordTab, saveTrackRecordTab, type TrackRecordTab } from '@/lib/ui-persist'

/* ------------------------------------------------------------------ */
/*  Types (mirrors server TrackRecordResponse)                         */
/* ------------------------------------------------------------------ */

type SignalOutcome = {
  card_id: string
  card_name: string
  set_name: string | null
  image_url: string | null
  signal_date: string
  price_at_signal: number
  current_price: number
  return_pct: number
  days_held: number
  status: 'active' | 'resolved_win' | 'resolved_loss'
}

type AccuracyPoint = {
  date: string
  mean_error_pct: number
  signal_count: number
  hit_rate: number | null
}

type PredVsActual = { predicted: number; actual: number; name: string }

type TrackRecordMeta = {
  first_snapshot_date: string | null
  last_snapshot_date: string | null
  total_snapshot_days: number
  total_cards_tracked: number
  total_signals_ever: number
  model_refresh_frequency: string
  snapshot_frequency: string
  signal_evaluation_threshold_days: number
  valuation_thresholds: { undervalued_ratio: number; overvalued_ratio: number }
}

type TrackRecordData = {
  meta: TrackRecordMeta
  confidence_score: number
  prediction_accuracy_pct: number
  buy_signal_hit_rate: number
  buy_signal_avg_return: number
  total_signals_evaluated: number
  active_signals: number
  accuracy_timeline: AccuracyPoint[]
  top_winners: SignalOutcome[]
  notable_misses: SignalOutcome[]
  active_signal_details: SignalOutcome[]
  prediction_vs_actual: PredVsActual[]
}

type TabId = TrackRecordTab

const TAB_LABELS: { id: TabId; label: string; desc: string }[] = [
  { id: 'overview', label: 'Overview', desc: 'Confidence score and key metrics' },
  { id: 'charts', label: 'Trends', desc: 'Performance charts over time' },
  { id: 'accuracy', label: 'Accuracy Map', desc: 'Predicted vs actual prices' },
  { id: 'signals', label: 'Signals', desc: 'Buy signal outcomes and tracking' },
]

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtDate(d: string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function daysBetween(a: string | null, b: string | null): number {
  if (!a || !b) return 0
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000)
}

/* ------------------------------------------------------------------ */
/*  Confidence Gauge (SVG ring)                                        */
/* ------------------------------------------------------------------ */

function ConfidenceGauge({ score, size = 180 }: { score: number; size?: number }) {
  const clamped = Math.max(0, Math.min(100, score))
  const half = size / 2
  const radius = half - 18
  const stroke = 10
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - clamped / 100)
  const color =
    clamped >= 70 ? 'text-emerald-500' : clamped >= 45 ? 'text-amber-500' : 'text-red-500'
  const bgRing = 'text-muted/30'
  const label =
    clamped >= 80 ? 'Excellent' : clamped >= 65 ? 'Good' : clamped >= 45 ? 'Fair' : 'Building'

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative flex items-center justify-center">
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={half} cy={half} r={radius} fill="none" strokeWidth={stroke} className={cn('stroke-current', bgRing)} />
          <circle cx={half} cy={half} r={radius} fill="none" strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={circumference} strokeDashoffset={dashOffset}
            className={cn('stroke-current transition-all duration-1000 ease-out', color)} />
        </svg>
        <div className="absolute flex flex-col items-center">
          <span className={cn('text-4xl font-bold tabular-nums', color)}>{clamped}</span>
          <span className="text-xs font-medium text-muted-foreground">/ 100</span>
        </div>
      </div>
      <div className="flex flex-col items-center gap-0.5">
        <p className={cn('text-sm font-semibold', color)}>{label}</p>
        <p className="text-xs text-muted-foreground">Model Confidence</p>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Data Coverage Banner                                               */
/* ------------------------------------------------------------------ */

function DataCoverageBanner({ meta }: { meta: TrackRecordMeta }) {
  const span = daysBetween(meta.first_snapshot_date, meta.last_snapshot_date)
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
        <div>
          <span className="text-muted-foreground">Tracking since </span>
          <span className="font-medium">{fmtDate(meta.first_snapshot_date)}</span>
        </div>
        <Separator orientation="vertical" className="hidden h-4 sm:block" />
        <div>
          <span className="text-muted-foreground">Latest snapshot </span>
          <span className="font-medium">{fmtDate(meta.last_snapshot_date)}</span>
        </div>
        <Separator orientation="vertical" className="hidden h-4 sm:block" />
        <div>
          <span className="text-muted-foreground">Time span </span>
          <span className="font-medium">{span > 0 ? `${span} days` : 'Today'}</span>
        </div>
        <Separator orientation="vertical" className="hidden h-4 sm:block" />
        <div>
          <span className="text-muted-foreground">Snapshots </span>
          <span className="font-medium">{meta.total_snapshot_days}</span>
        </div>
        <Separator orientation="vertical" className="hidden h-4 sm:block" />
        <div>
          <span className="text-muted-foreground">Cards tracked </span>
          <span className="font-medium">{meta.total_cards_tracked.toLocaleString()}</span>
        </div>
        <Separator orientation="vertical" className="hidden h-4 sm:block" />
        <div>
          <span className="text-muted-foreground">Buy signals issued </span>
          <span className="font-medium">{meta.total_signals_ever}</span>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Metric Card                                                        */
/* ------------------------------------------------------------------ */

function MetricCard({
  label,
  value,
  sub,
  detail,
  accent,
}: {
  label: string
  value: string
  sub?: string
  detail?: string
  accent?: 'green' | 'amber' | 'red' | 'blue' | 'default'
}) {
  const accentColor = {
    green: 'text-emerald-600 dark:text-emerald-400',
    amber: 'text-amber-600 dark:text-amber-400',
    red: 'text-red-600 dark:text-red-400',
    blue: 'text-sky-600 dark:text-sky-400',
    default: 'text-foreground',
  }[accent ?? 'default']

  return (
    <Card>
      <CardContent className="flex flex-col gap-1 p-4">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className={cn('text-2xl font-bold tabular-nums', accentColor)}>{value}</p>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
        {detail && <p className="mt-1 text-[10px] leading-snug text-muted-foreground/70">{detail}</p>}
      </CardContent>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/*  Methodology Card (explains the scoring to user)                    */
/* ------------------------------------------------------------------ */

function MethodologyCard({ meta }: { meta: TrackRecordMeta }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-1">
          <CardTitle className="text-sm">How This Works</CardTitle>
          <HelpButton sectionId="track-record-methodology" />
        </div>
        <CardDescription>Understanding what these numbers mean</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-xs text-muted-foreground">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1 rounded-md border border-border p-2.5">
            <p className="font-medium text-foreground">Confidence Score (0–100)</p>
            <p>
              A weighted blend: 50% prediction accuracy + 30% signal hit rate + 20% sample size depth.
              Higher scores mean the model has consistently produced accurate estimates with a solid track record of profitable buy signals.
            </p>
          </div>
          <div className="space-y-1 rounded-md border border-border p-2.5">
            <p className="font-medium text-foreground">Prediction Accuracy</p>
            <p>
              Measures how close the model&apos;s &quot;fair value&quot; estimate is to the actual market price.
              Calculated as (1 - median absolute percentage error) &times; 100. A score of 85% means the model is typically within 15% of actual prices.
            </p>
          </div>
          <div className="space-y-1 rounded-md border border-border p-2.5">
            <p className="font-medium text-foreground">Buy Signal Hit Rate</p>
            <p>
              Of all cards flagged as &quot;UNDERVALUED — BUY SIGNAL&quot; (market/fair &lt; {meta.valuation_thresholds.undervalued_ratio}),
              what percentage actually increased in price? Signals are evaluated after {meta.signal_evaluation_threshold_days}+ days to allow market movement.
            </p>
          </div>
          <div className="space-y-1 rounded-md border border-border p-2.5">
            <p className="font-medium text-foreground">Data Collection</p>
            <p>
              {meta.snapshot_frequency}. Each snapshot captures every card&apos;s predicted price, market price, and valuation flag.
              The model refreshes {meta.model_refresh_frequency.toLowerCase()}.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/*  Prediction vs Actual scatter (custom SVG)                          */
/* ------------------------------------------------------------------ */

function PredictionScatter({ data }: { data: PredVsActual[] }) {
  const filtered = useMemo(() => data.filter((d) => d.actual > 0.5 && d.predicted > 0.5), [data])
  if (filtered.length < 3)
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        Not enough prediction data yet — scatter appears after 3+ priced cards
      </div>
    )

  const maxVal = Math.max(...filtered.map((d) => Math.max(d.predicted, d.actual))) * 1.1
  const W = 400
  const H = 300
  const pad = { top: 20, right: 20, bottom: 40, left: 50 }
  const iw = W - pad.left - pad.right
  const ih = H - pad.top - pad.bottom
  const sx = (v: number) => pad.left + (v / maxVal) * iw
  const sy = (v: number) => pad.top + ih - (v / maxVal) * ih

  const ticks = [0, maxVal * 0.25, maxVal * 0.5, maxVal * 0.75, maxVal]
  const fmtTick = (n: number) => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(1)}`)

  const underCount = filtered.filter((d) => d.predicted > d.actual * 1.25).length
  const overCount = filtered.filter((d) => d.actual > d.predicted * 1.25).length
  const fairCount = filtered.length - underCount - overCount

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span>{filtered.length} cards plotted</span>
        <span className="text-emerald-600 dark:text-emerald-400">{underCount} undervalued</span>
        <span className="text-sky-600 dark:text-sky-400">{fairCount} fair</span>
        <span className="text-red-600 dark:text-red-400">{overCount} overvalued</span>
      </div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="mx-auto w-full max-w-xl" preserveAspectRatio="xMidYMid meet">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.left} y1={sy(t)} x2={W - pad.right} y2={sy(t)} className="stroke-border" strokeDasharray="3,3" />
              <text x={pad.left - 6} y={sy(t) + 3} textAnchor="end" className="fill-muted-foreground text-[9px]">{fmtTick(t)}</text>
              <line x1={sx(t)} y1={pad.top} x2={sx(t)} y2={H - pad.bottom} className="stroke-border" strokeDasharray="3,3" />
              <text x={sx(t)} y={H - pad.bottom + 14} textAnchor="middle" className="fill-muted-foreground text-[9px]">{fmtTick(t)}</text>
            </g>
          ))}
          <line x1={pad.left} y1={sy(0)} x2={sx(maxVal)} y2={sy(maxVal)} className="stroke-primary/30" strokeWidth={1.5} strokeDasharray="6,4" />
          {filtered.map((d, i) => {
            const isUnder = d.predicted > d.actual * 1.25
            const isOver = d.actual > d.predicted * 1.25
            const fill = isUnder ? 'fill-emerald-500/60' : isOver ? 'fill-red-500/60' : 'fill-sky-500/60'
            return (
              <circle key={i} cx={sx(d.actual)} cy={sy(d.predicted)} r={3.5} className={cn(fill, 'transition-opacity hover:opacity-100')} opacity={0.7}>
                <title>{d.name}: predicted ${d.predicted.toFixed(2)} / actual ${d.actual.toFixed(2)}</title>
              </circle>
            )
          })}
          <text x={W / 2} y={H - 4} textAnchor="middle" className="fill-muted-foreground text-[10px] font-medium">Actual Market Price</text>
          <text x={12} y={H / 2} textAnchor="middle" className="fill-muted-foreground text-[10px] font-medium" transform={`rotate(-90, 12, ${H / 2})`}>Model Fair Value</text>
        </svg>
      </div>
      <div className="flex flex-wrap justify-center gap-4 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1"><span className="inline-block size-2.5 rounded-full bg-emerald-500/60" /> Undervalued (buy signal)</span>
        <span className="flex items-center gap-1"><span className="inline-block size-2.5 rounded-full bg-sky-500/60" /> Fair value</span>
        <span className="flex items-center gap-1"><span className="inline-block size-2.5 rounded-full bg-red-500/60" /> Overvalued</span>
        <span className="flex items-center gap-1"><span className="inline-block h-px w-4 border-t border-dashed border-primary/30" /> Perfect accuracy line</span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Signal table                                                       */
/* ------------------------------------------------------------------ */

function SignalTable({
  title,
  description,
  signals,
  emptyMsg,
  variant,
  count,
}: {
  title: string
  description: string
  signals: SignalOutcome[]
  emptyMsg: string
  variant: 'winner' | 'loss' | 'active'
  count?: number
}) {
  if (signals.length === 0) {
    return (
      <div className="rounded-lg border border-border p-4">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-[10px] text-muted-foreground">{description}</p>
        <p className="mt-3 text-xs text-muted-foreground">{emptyMsg}</p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-border">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">{title}</p>
          {count != null && (
            <Badge variant="outline" className="text-[10px]">{count}</Badge>
          )}
        </div>
        <p className="mt-0.5 text-[10px] text-muted-foreground">{description}</p>
      </div>
      <div className="max-h-80 divide-y divide-border overflow-y-auto">
        {signals.map((s) => (
          <div key={s.card_id + s.signal_date} className="flex items-center gap-3 px-4 py-2.5">
            {s.image_url && (
              <img src={s.image_url} alt={s.card_name} className="h-10 w-7 rounded object-cover" loading="lazy" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{s.card_name}</p>
              <p className="text-[10px] text-muted-foreground">
                {s.set_name ?? '—'} · Signal {new Date(s.signal_date).toLocaleDateString()} · {s.days_held}d held
              </p>
            </div>
            <div className="flex flex-col items-end gap-0.5">
              <span className={cn(
                'text-sm font-semibold tabular-nums',
                variant === 'winner' || (variant === 'active' && s.return_pct > 0)
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : variant === 'loss' || (variant === 'active' && s.return_pct < 0)
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-foreground',
              )}>
                {s.return_pct > 0 ? '+' : ''}{s.return_pct.toFixed(1)}%
              </span>
              <span className="text-[10px] tabular-nums text-muted-foreground">
                ${s.price_at_signal.toFixed(2)} → ${s.current_price.toFixed(2)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Empty state for fresh installs                                     */
/* ------------------------------------------------------------------ */

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <div className="rounded-full bg-muted p-5">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="size-10 text-muted-foreground"><path d="M12 20V10" /><path d="M18 20V4" /><path d="M6 20v-4" /></svg>
      </div>
      <div>
        <p className="text-lg font-semibold">Building your track record</p>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          The model snapshots predictions after each refresh. As data accumulates over days and weeks,
          this page will show how well buy signals performed and how accurate pricing predictions are.
        </p>
      </div>
      <Badge variant="outline" className="text-xs">
        First snapshot taken on next model refresh
      </Badge>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Tab: Overview                                                      */
/* ------------------------------------------------------------------ */

function OverviewTab({ data }: { data: TrackRecordData }) {
  const hitRateAccent: 'green' | 'amber' | 'red' =
    data.buy_signal_hit_rate >= 60 ? 'green' : data.buy_signal_hit_rate >= 40 ? 'amber' : 'red'
  const returnAccent: 'green' | 'amber' | 'red' =
    data.buy_signal_avg_return > 0 ? 'green' : data.buy_signal_avg_return > -5 ? 'amber' : 'red'
  const span = daysBetween(data.meta.first_snapshot_date, data.meta.last_snapshot_date)
  const timeLabel = span > 0 ? `Over ${span} days of tracking` : 'From today\u2019s snapshot'

  return (
    <div className="space-y-4">
      {/* Gauge + Metrics */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Card className="flex items-center justify-center sm:col-span-2 lg:col-span-1 lg:row-span-2">
          <CardContent className="p-6">
            <ConfidenceGauge score={data.confidence_score} />
          </CardContent>
        </Card>
        <MetricCard
          label="Prediction Accuracy"
          value={`${data.prediction_accuracy_pct.toFixed(1)}%`}
          sub="How close fair value is to market"
          detail={`Median absolute error across ${data.meta.total_cards_tracked.toLocaleString()} cards. ${timeLabel}.`}
          accent={data.prediction_accuracy_pct >= 80 ? 'green' : data.prediction_accuracy_pct >= 60 ? 'amber' : 'red'}
        />
        <MetricCard
          label="Buy Signal Hit Rate"
          value={`${data.buy_signal_hit_rate.toFixed(1)}%`}
          sub={`${data.total_signals_evaluated} of ${data.meta.total_signals_ever} signals evaluated`}
          detail={`Signals are evaluated ${data.meta.signal_evaluation_threshold_days}+ days after issuance to allow market movement.`}
          accent={hitRateAccent}
        />
        <MetricCard
          label="Avg Signal Return"
          value={`${data.buy_signal_avg_return > 0 ? '+' : ''}${data.buy_signal_avg_return.toFixed(1)}%`}
          sub="Mean return from signal date to now"
          detail="Compares the card's market price when flagged to its current market price."
          accent={returnAccent}
        />
        <MetricCard
          label="Active Signals"
          value={String(data.active_signals)}
          sub="Awaiting evaluation"
          detail={`Cards flagged UNDERVALUED fewer than ${data.meta.signal_evaluation_threshold_days} days ago. Not yet counted in hit rate.`}
          accent="blue"
        />
      </div>

      {/* Methodology */}
      <MethodologyCard meta={data.meta} />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Tab: Charts                                                        */
/* ------------------------------------------------------------------ */

function ChartsTab({ data }: { data: TrackRecordData }) {
  const span = daysBetween(data.meta.first_snapshot_date, data.meta.last_snapshot_date)
  const chartPeriodLabel = span > 0 ? `${fmtDate(data.meta.first_snapshot_date)} — ${fmtDate(data.meta.last_snapshot_date)} (${span} days)` : 'Today'

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Showing trend data for the period: <span className="font-medium text-foreground">{chartPeriodLabel}</span>.
        New data points are added each time the model runs.
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Accuracy timeline */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-1">
              <CardTitle className="text-sm">Prediction Error Over Time</CardTitle>
              <HelpButton sectionId="track-record-timeline" />
            </div>
            <CardDescription>
              Lower is better — measures how far the model&apos;s fair value drifts from actual market. Each point is the median error for that snapshot day.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.accuracy_timeline.length >= 2 ? (
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
                  <AreaChart data={data.accuracy_timeline} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="gradError" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }}
                      tickFormatter={(d: string) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      className="text-muted-foreground" />
                    <YAxis tickFormatter={formatPctAxis} width={38} tick={{ fontSize: 10 }} className="text-muted-foreground" />
                    <Tooltip
                      contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }}
                      labelFormatter={(d: unknown) => new Date(String(d)).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                      formatter={(v: unknown, _n: unknown, entry: { payload?: AccuracyPoint }) => {
                        const pt = entry?.payload
                        return [`${Number(v).toFixed(1)}% error${pt ? ` · ${pt.signal_count} signals active` : ''}`, 'Median Error']
                      }}
                    />
                    <Area type="monotone" dataKey="mean_error_pct" stroke="hsl(var(--chart-1))" fill="url(#gradError)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="flex h-56 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
                <p>Collecting data — chart appears after 2+ daily snapshots</p>
                <p className="text-[10px]">Snapshots taken: {data.meta.snapshot_frequency.toLowerCase()}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Hit rate timeline */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-1">
              <CardTitle className="text-sm">Signal Hit Rate Over Time</CardTitle>
              <HelpButton sectionId="track-record-hit-rate" />
            </div>
            <CardDescription>
              Running percentage of buy signals that resulted in positive returns. A rising line means improving signal quality.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.accuracy_timeline.filter((p) => p.hit_rate != null).length >= 2 ? (
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
                  <LineChart data={data.accuracy_timeline.filter((p) => p.hit_rate != null)} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }}
                      tickFormatter={(d: string) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      className="text-muted-foreground" />
                    <YAxis domain={[0, 1]} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} width={38} tick={{ fontSize: 10 }} className="text-muted-foreground" />
                    <Tooltip
                      contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }}
                      labelFormatter={(d: unknown) => new Date(String(d)).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                      formatter={(v: unknown) => [`${(Number(v) * 100).toFixed(1)}%`, 'Cumulative Hit Rate']}
                    />
                    <Line type="monotone" dataKey="hit_rate" stroke="hsl(var(--chart-2))" strokeWidth={2} dot={{ r: 3, fill: 'hsl(var(--chart-2))' }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="flex h-56 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
                <p>Chart appears after signals have been evaluated</p>
                <p className="text-[10px]">Signals need {data.meta.signal_evaluation_threshold_days}+ days before evaluation</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Quick stats bar under charts */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-md border border-border p-2.5 text-center">
          <p className="text-lg font-semibold tabular-nums">{data.accuracy_timeline.length}</p>
          <p className="text-[10px] text-muted-foreground">Data points</p>
        </div>
        <div className="rounded-md border border-border p-2.5 text-center">
          <p className="text-lg font-semibold tabular-nums">{data.meta.total_snapshot_days}</p>
          <p className="text-[10px] text-muted-foreground">Snapshot days</p>
        </div>
        <div className="rounded-md border border-border p-2.5 text-center">
          <p className="text-lg font-semibold tabular-nums">{data.meta.total_signals_ever}</p>
          <p className="text-[10px] text-muted-foreground">Signals issued</p>
        </div>
        <div className="rounded-md border border-border p-2.5 text-center">
          <p className="text-lg font-semibold tabular-nums">{data.total_signals_evaluated}</p>
          <p className="text-[10px] text-muted-foreground">Signals evaluated</p>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Tab: Accuracy Map                                                  */
/* ------------------------------------------------------------------ */

function AccuracyTab({ data }: { data: TrackRecordData }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-1">
            <CardTitle className="text-sm">Model Fair Value vs Actual Market Price</CardTitle>
            <HelpButton sectionId="track-record-scatter" />
          </div>
          <CardDescription>
            Each dot is one card from today&apos;s data. Points on the dashed diagonal line mean the model perfectly predicted the market price.
            Points <span className="text-emerald-600 dark:text-emerald-400">above the line</span> are undervalued
            (model fair &gt; market); points <span className="text-red-600 dark:text-red-400">below</span> are overvalued.
            A tight cluster along the diagonal = high accuracy.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PredictionScatter data={data.prediction_vs_actual} />
        </CardContent>
      </Card>

      {/* Interpretation guide */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Reading the Accuracy Map</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 text-xs text-muted-foreground sm:grid-cols-3">
            <div className="rounded-md border border-border p-2.5">
              <p className="mb-1 font-medium text-emerald-600 dark:text-emerald-400">Above the Line</p>
              <p>The model estimates a higher fair value than the current market price. These are potential undervalued opportunities — the basis for buy signals.</p>
            </div>
            <div className="rounded-md border border-border p-2.5">
              <p className="mb-1 font-medium text-sky-600 dark:text-sky-400">On / Near the Line</p>
              <p>Model and market agree closely. These cards are fairly priced according to our analysis. No strong buy or sell signal.</p>
            </div>
            <div className="rounded-md border border-border p-2.5">
              <p className="mb-1 font-medium text-red-600 dark:text-red-400">Below the Line</p>
              <p>Market price exceeds model fair value. These may be overvalued — the market is pricing them higher than fundamentals suggest.</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Tab: Signals                                                       */
/* ------------------------------------------------------------------ */

function SignalsTab({ data }: { data: TrackRecordData }) {
  const totalOutcomes = data.top_winners.length + data.notable_misses.length + data.active_signal_details.length
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/40 p-3">
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs">
          <div>
            <span className="text-muted-foreground">Total signals tracked: </span>
            <span className="font-medium">{totalOutcomes}</span>
          </div>
          <Separator orientation="vertical" className="hidden h-4 sm:block" />
          <div>
            <span className="text-muted-foreground">Evaluated (7d+): </span>
            <span className="font-medium">{data.total_signals_evaluated}</span>
          </div>
          <Separator orientation="vertical" className="hidden h-4 sm:block" />
          <div>
            <span className="text-muted-foreground">Winners: </span>
            <span className="font-medium text-emerald-600 dark:text-emerald-400">{data.top_winners.length}</span>
          </div>
          <Separator orientation="vertical" className="hidden h-4 sm:block" />
          <div>
            <span className="text-muted-foreground">Misses: </span>
            <span className="font-medium text-red-600 dark:text-red-400">{data.notable_misses.length}</span>
          </div>
          <Separator orientation="vertical" className="hidden h-4 sm:block" />
          <div>
            <span className="text-muted-foreground">Still active: </span>
            <span className="font-medium text-sky-600 dark:text-sky-400">{data.active_signal_details.length}</span>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <SignalTable
          title="Top Winners"
          description="Buy signals with the largest positive returns since signal date."
          signals={data.top_winners}
          emptyMsg="No winning signals yet — keep tracking! Winners appear after signals are active 7+ days and the price has risen."
          variant="winner"
          count={data.top_winners.length}
        />
        <SignalTable
          title="Active Signals"
          description={`Cards flagged UNDERVALUED fewer than ${data.meta.signal_evaluation_threshold_days} days ago. Tracking in progress.`}
          signals={data.active_signal_details}
          emptyMsg="No active buy signals right now — new signals appear when the model flags cards as undervalued."
          variant="active"
          count={data.active_signal_details.length}
        />
        <SignalTable
          title="Notable Misses"
          description="Buy signals where the price decreased after the signal date."
          signals={data.notable_misses}
          emptyMsg="No losing signals yet — either still early or the model is performing well!"
          variant="loss"
          count={data.notable_misses.length}
        />
      </div>

      <p className="text-center text-[10px] text-muted-foreground">
        Signal evaluation: a card is &quot;evaluated&quot; once it has been an active buy signal for {data.meta.signal_evaluation_threshold_days}+ days.
        Return = (current market price - price at signal date) / price at signal date.
        Signals are sourced from both prediction snapshots and legacy undervalued_since timestamps.
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Main page                                                          */
/* ------------------------------------------------------------------ */

export function TrackRecordPage() {
  const [activeTab, _setActiveTab] = useState<TabId>(() => loadTrackRecordTab())
  const setActiveTab = (t: TabId) => { _setActiveTab(t); saveTrackRecordTab(t) }

  const q = useQuery({
    queryKey: ['api', 'track-record'],
    queryFn: () => api<TrackRecordData>('/api/track-record'),
    staleTime: 60_000,
  })

  const data = q.data

  if (q.isPending) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }

  if (q.error) {
    return (
      <div className="py-12 text-center text-sm text-red-500">
        Failed to load track record: {q.error.message}
      </div>
    )
  }

  if (!data) return null

  const hasData =
    data.total_signals_evaluated > 0 ||
    data.active_signals > 0 ||
    (data.meta?.total_snapshot_days ?? 0) > 0 ||
    data.prediction_vs_actual.length > 0

  if (!hasData) return <EmptyState />

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold sm:text-2xl">Track Record</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Transparent model performance — see how predictions and buy signals perform over time.
          </p>
        </div>
        <HelpButton sectionId="track-record-overview" />
      </div>

      {/* Data coverage banner */}
      <DataCoverageBanner meta={data.meta} />

      {/* Tab navigation */}
      <nav className="flex gap-1 overflow-x-auto rounded-lg border border-border bg-muted/50 p-1">
        {TAB_LABELS.map((t) => (
          <Button
            key={t.id}
            variant={activeTab === t.id ? 'secondary' : 'ghost'}
            size="sm"
            className={cn(
              'shrink-0 gap-1 text-xs',
              activeTab === t.id ? 'shadow-sm' : 'text-muted-foreground',
            )}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </Button>
        ))}
      </nav>

      {/* Active tab description */}
      <p className="text-xs text-muted-foreground">
        {TAB_LABELS.find((t) => t.id === activeTab)?.desc}
      </p>

      {/* Tab content */}
      {activeTab === 'overview' && <OverviewTab data={data} />}
      {activeTab === 'charts' && <ChartsTab data={data} />}
      {activeTab === 'accuracy' && <AccuracyTab data={data} />}
      {activeTab === 'signals' && <SignalsTab data={data} />}
    </div>
  )
}
