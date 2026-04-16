import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Button, buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { api, type CardFiltersMeta, type CardRow, type CardsListResponse } from '@/lib/api'
import { formatCountAxis, formatScoreAxis, formatUsdAxis } from '@/lib/chart-format'
import {
  cardsFiltersToSearchParams,
  loadDashboardPrefs,
  saveDashboardPrefs,
  type CardsFiltersPersisted,
  type DashboardChartKind,
  type DashboardPrefs,
} from '@/lib/ui-persist'
import { cn } from '@/lib/utils'
import { buildSocialMomentumRows } from '@/lib/social-momentum'
import { HelpButton } from '@/components/help-center'

type DashKpis = {
  totalCards: number
  undervaluedSignals: number
  avgModelAccuracy: number
  portfolioValue: number
}

type ScatterPt = {
  x: number
  y: number
  z: number
  name: string
  flag: string | null
  id: string
  set_id: string | null
  market: number | null
  predicted: number | null
  dealPct: number | null
}

type SetRipRow = {
  id: string
  name: string
  rip_or_singles_verdict: string | null
}

const CHART_CHOICES: {
  value: DashboardChartKind
  label: string
  blurb: string
}[] = [
  {
    value: 'pull_desire',
    label: 'Pull vs demand',
    blurb: 'How hard a card is to pull versus how much people want it. Great for spotting “chase” character cards.',
  },
  {
    value: 'fair_market',
    label: 'Price reality check',
    blurb: 'Listed price (across) vs model fair value (up). Points under the diagonal are cheaper than the model expects.',
  },
  {
    value: 'deal_mix',
    label: 'Deal strength mix',
    blurb: 'How many cards fall into each “% below fair” bucket — see if the market is broadly tight or there are pockets of value.',
  },
  {
    value: 'sets_rank',
    label: 'Sets with the most deals',
    blurb: 'Which expansions currently have the most singles meeting your “minimum deal” bar (after filters).',
  },
]

function dealPct(c: CardRow): number | null {
  const fair = c.predicted_price
  const mkt = c.market_price
  if (fair == null || mkt == null || fair <= 0) return null
  return ((fair - mkt) / fair) * 100
}

function passesMinFair(c: CardRow, minUsd: number): boolean {
  return (c.predicted_price ?? 0) >= minUsd
}

function bubbleZRange(scale: DashboardPrefs['bubbleScale']): [number, number] {
  switch (scale) {
    case 's':
      return [28, 240]
    case 'l':
      return [52, 520]
    default:
      return [40, 400]
  }
}

function classifyRipVerdict(verdict: string | null): 'buy_singles' | 'rip' | 'neutral' {
  const v = verdict ?? ''
  if (v.includes('🟢') || v.includes('Buy singles')) return 'buy_singles'
  if (v.includes('🔴') || v.includes("Don't rip") || v.includes('Don\u2019t rip')) return 'rip'
  return 'neutral'
}

const SV = { w: 800, h: 420 }
const SM = { t: 24, r: 16, b: 50, l: 60 }
const SP = { w: SV.w - SM.l - SM.r, h: SV.h - SM.t - SM.b }

function niceTicks(lo: number, hi: number, approx: number): number[] {
  const range = hi - lo
  if (range <= 0) return [lo]
  const raw = range / Math.max(1, approx)
  const exp = Math.pow(10, Math.floor(Math.log10(raw)))
  const frac = raw / exp
  const nice = frac <= 1.5 ? 1 : frac <= 3 ? 2 : frac <= 7 ? 5 : 10
  const step = nice * exp
  const start = Math.ceil(lo / step) * step
  const out: number[] = []
  for (let v = start; v <= hi + step * 1e-6; v += step) out.push(Math.round(v / step) * step)
  return out
}

function RawScatter({
  data, xDomain, yDomain, xLabel, yLabel,
  xFmt = String, yFmt = String,
  selectedId, minDealPercent, zRange,
  onSelect, onHover, onLeave,
  diag, quadrants, refX, refY,
}: {
  data: ScatterPt[]
  xDomain: [number, number]
  yDomain: [number, number]
  xLabel: string
  yLabel: string
  xFmt?: (v: number) => string
  yFmt?: (v: number) => string
  selectedId: string | null
  minDealPercent: number
  zRange: [number, number]
  onSelect: (id: string) => void
  onHover: (id: string, e: React.MouseEvent) => void
  onLeave: () => void
  diag?: boolean
  quadrants?: boolean
  refX?: number
  refY?: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const clipId = useMemo(() => `rsc-${Math.random().toString(36).slice(2, 8)}`, [])

  const [vd, setVd] = useState<{ x: [number, number]; y: [number, number] }>({
    x: [...xDomain] as [number, number],
    y: [...yDomain] as [number, number],
  })
  const vdRef = useRef(vd)
  vdRef.current = vd
  const fullXRef = useRef(xDomain)
  const fullYRef = useRef(yDomain)
  fullXRef.current = xDomain
  fullYRef.current = yDomain

  useEffect(() => {
    setVd({ x: [...xDomain] as [number, number], y: [...yDomain] as [number, number] })
  }, [xDomain[0], xDomain[1], yDomain[0], yDomain[1]])

  const fullXRange = xDomain[1] - xDomain[0]
  const fullYRange = yDomain[1] - yDomain[0]
  const isZoomed = (vd.x[1] - vd.x[0]) < fullXRange * 0.98 || (vd.y[1] - vd.y[0]) < fullYRange * 0.98
  const zoomLevel = Math.max(fullXRange / (vd.x[1] - vd.x[0]), fullYRange / (vd.y[1] - vd.y[0]))

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const cur = vdRef.current
      const fx = fullXRef.current, fy = fullYRef.current
      const mxFrac = (e.clientX - rect.left) / rect.width
      const myFrac = (e.clientY - rect.top) / rect.height
      const plotFx = Math.max(0, Math.min(1, (mxFrac * SV.w - SM.l) / SP.w))
      const plotFy = Math.max(0, Math.min(1, 1 - (myFrac * SV.h - SM.t) / SP.h))
      const dataX = cur.x[0] + plotFx * (cur.x[1] - cur.x[0])
      const dataY = cur.y[0] + plotFy * (cur.y[1] - cur.y[0])
      const factor = e.deltaY < 0 ? 0.82 : 1 / 0.82
      let xr = (cur.x[1] - cur.x[0]) * factor
      let yr = (cur.y[1] - cur.y[0]) * factor
      const fxr = fx[1] - fx[0], fyr = fy[1] - fy[0]
      if (xr >= fxr && yr >= fyr) { setVd({ x: [...fx] as [number, number], y: [...fy] as [number, number] }); return }
      const minR = 0.02
      xr = Math.max(fxr * minR, Math.min(fxr, xr))
      yr = Math.max(fyr * minR, Math.min(fyr, yr))
      let x0 = dataX - plotFx * xr, x1 = dataX + (1 - plotFx) * xr
      let y0 = dataY - plotFy * yr, y1 = dataY + (1 - plotFy) * yr
      if (x0 < fx[0]) { x1 += fx[0] - x0; x0 = fx[0] }
      if (x1 > fx[1]) { x0 -= x1 - fx[1]; x1 = fx[1] }
      if (y0 < fy[0]) { y1 += fy[0] - y0; y0 = fy[0] }
      if (y1 > fy[1]) { y0 -= y1 - fy[1]; y1 = fy[1] }
      setVd({
        x: [Math.max(fx[0], x0), Math.min(fx[1], x1)],
        y: [Math.max(fy[0], y0), Math.min(fy[1], y1)],
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const panRef = useRef<{
    sx: number; sy: number
    vdx: [number, number]; vdy: [number, number]
    dragging: boolean
  } | null>(null)

  const startPan = (e: React.MouseEvent) => {
    if (!isZoomed || e.button !== 0) return
    panRef.current = { sx: e.clientX, sy: e.clientY, vdx: [...vd.x] as [number, number], vdy: [...vd.y] as [number, number], dragging: false }
  }
  const movePan = (e: React.MouseEvent) => {
    const p = panRef.current
    if (!p || !containerRef.current) return
    const dx = e.clientX - p.sx, dy = e.clientY - p.sy
    if (!p.dragging && Math.hypot(dx, dy) < 4) return
    p.dragging = true
    const rect = containerRef.current.getBoundingClientRect()
    const xr = p.vdx[1] - p.vdx[0], yr = p.vdy[1] - p.vdy[0]
    const ratioX = SV.w / SP.w, ratioY = SV.h / SP.h
    const ddx = -(dx / rect.width) * xr * ratioX
    const ddy = (dy / rect.height) * yr * ratioY
    const fx = fullXRef.current, fy = fullYRef.current
    let x0 = p.vdx[0] + ddx, x1 = p.vdx[1] + ddx
    let y0 = p.vdy[0] + ddy, y1 = p.vdy[1] + ddy
    if (x0 < fx[0]) { x1 += fx[0] - x0; x0 = fx[0] }
    if (x1 > fx[1]) { x0 -= x1 - fx[1]; x1 = fx[1] }
    if (y0 < fy[0]) { y1 += fy[0] - y0; y0 = fy[0] }
    if (y1 > fy[1]) { y0 -= y1 - fy[1]; y1 = fy[1] }
    setVd({
      x: [Math.max(fx[0], x0), Math.min(fx[1], x1)],
      y: [Math.max(fy[0], y0), Math.min(fy[1], y1)],
    })
  }
  const endPan = () => { panRef.current = null }

  const sx = (v: number) => SM.l + ((v - vd.x[0]) / (vd.x[1] - vd.x[0])) * SP.w
  const sy = (v: number) => SM.t + SP.h - ((v - vd.y[0]) / (vd.y[1] - vd.y[0])) * SP.h
  const xTicks = niceTicks(vd.x[0], vd.x[1], 8)
  const yTicks = niceTicks(vd.y[0], vd.y[1], 6)
  const fg = 'hsl(var(--foreground))'
  const grid = 'hsl(var(--border))'
  const sizeScale = zRange[1] / 400

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5 text-[0.65rem] text-muted-foreground">
        <span>{isZoomed ? `${zoomLevel.toFixed(1)}× — drag to pan` : 'Scroll to zoom'}</span>
        {isZoomed && (
          <button type="button" className="rounded px-1.5 py-0.5 font-medium text-primary hover:bg-muted"
            onClick={() => setVd({ x: [...xDomain] as [number, number], y: [...yDomain] as [number, number] })}>
            Reset zoom
          </button>
        )}
      </div>
      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden"
        style={{ cursor: isZoomed ? (panRef.current?.dragging ? 'grabbing' : 'grab') : undefined }}
        onMouseDown={startPan} onMouseMove={movePan} onMouseUp={endPan}
        onMouseLeave={() => { endPan(); onLeave() }}>
        <svg viewBox={`0 0 ${SV.w} ${SV.h}`} className="h-full w-full" style={{ userSelect: 'none' }}>
          <defs>
            <clipPath id={clipId}><rect x={SM.l} y={SM.t} width={SP.w} height={SP.h} /></clipPath>
          </defs>

          <g clipPath={`url(#${clipId})`}>
            {xTicks.map((v) => (
              <line key={`gx${v}`} x1={sx(v)} x2={sx(v)} y1={SM.t} y2={SM.t + SP.h}
                stroke={grid} strokeOpacity={0.3} strokeDasharray="3 6" />
            ))}
            {yTicks.map((v) => (
              <line key={`gy${v}`} x1={SM.l} x2={SM.l + SP.w} y1={sy(v)} y2={sy(v)}
                stroke={grid} strokeOpacity={0.3} strokeDasharray="3 6" />
            ))}

            {refX != null && (
              <line x1={sx(refX)} x2={sx(refX)} y1={SM.t} y2={SM.t + SP.h}
                stroke="hsl(var(--primary))" strokeDasharray="4 4" strokeOpacity={0.25} />
            )}
            {refY != null && (
              <line x1={SM.l} x2={SM.l + SP.w} y1={sy(refY)} y2={sy(refY)}
                stroke="hsl(var(--primary))" strokeDasharray="4 4" strokeOpacity={0.25} />
            )}
            {diag && (
              <line x1={sx(vd.x[0])} y1={sy(vd.y[0])} x2={sx(vd.x[1])} y2={sy(vd.y[1])}
                stroke="hsl(var(--chart-2))" strokeWidth={1.5} strokeDasharray="6 5" strokeOpacity={0.85} />
            )}

            {quadrants && (
              <g className="pointer-events-none">
                <text x={SM.l + 8} y={SM.t + 16} textAnchor="start" fontSize={9} fill="hsl(var(--muted-foreground))" opacity={0.5} fontWeight={500}>Hard pull, High demand</text>
                <text x={SM.l + SP.w - 8} y={SM.t + 16} textAnchor="end" fontSize={9} fill="hsl(var(--muted-foreground))" opacity={0.5} fontWeight={500}>Easy pull, High demand</text>
                <text x={SM.l + 8} y={SM.t + SP.h - 8} textAnchor="start" fontSize={9} fill="hsl(var(--muted-foreground))" opacity={0.5} fontWeight={500}>Hard pull, Low demand</text>
                <text x={SM.l + SP.w - 8} y={SM.t + SP.h - 8} textAnchor="end" fontSize={9} fill="hsl(var(--muted-foreground))" opacity={0.5} fontWeight={500}>Easy pull, Low demand</text>
              </g>
            )}

            {data.map((pt) => {
              const px = sx(pt.x), py = sy(pt.y)
              if (px < SM.l - 2 || px > SM.l + SP.w + 2 || py < SM.t - 2 || py > SM.t + SP.h + 2) return null
              const r = (3 + Math.min(7, Math.log10(pt.z + 1) * 2)) * sizeScale
              const active = selectedId === pt.id
              const faded = pt.dealPct != null && pt.dealPct < minDealPercent && pt.dealPct >= 0
              const color = flagColor(pt.flag)
              const hitR = Math.max(r + 5, 12)
              return (
                <g key={pt.id}>
                  {active && <circle cx={px} cy={py} r={r + 5} fill="none" stroke={color} strokeWidth={1.5} opacity={0.5} />}
                  <circle cx={px} cy={py} r={active ? r + 1 : r} fill={color}
                    stroke={active ? fg : 'hsl(var(--background)/0.6)'}
                    strokeWidth={active ? 1.5 : 0.7}
                    opacity={faded ? 0.3 : 1}
                    style={{ pointerEvents: 'none' }} />
                  <circle cx={px} cy={py} r={hitR} fill="transparent" cursor="pointer"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => onSelect(pt.id)}
                    onMouseEnter={(e) => onHover(pt.id, e)}
                    onMouseLeave={onLeave} />
                </g>
              )
            })}
          </g>

          <line x1={SM.l} x2={SM.l + SP.w} y1={SM.t + SP.h} y2={SM.t + SP.h} stroke={fg} strokeOpacity={0.5} />
          <line x1={SM.l} x2={SM.l} y1={SM.t} y2={SM.t + SP.h} stroke={fg} strokeOpacity={0.5} />

          {xTicks.map((v) => (
            <text key={`tx${v}`} x={sx(v)} y={SM.t + SP.h + 18} textAnchor="middle" fontSize={11} fill={fg}>{xFmt(v)}</text>
          ))}
          {yTicks.map((v) => (
            <text key={`ty${v}`} x={SM.l - 8} y={sy(v) + 4} textAnchor="end" fontSize={11} fill={fg}>{yFmt(v)}</text>
          ))}

          <text x={SM.l + SP.w / 2} y={SV.h - 6} textAnchor="middle" fontSize={12} fontWeight={500} fill={fg}>{xLabel}</text>
          <text x={16} y={SM.t + SP.h / 2} transform={`rotate(-90 16 ${SM.t + SP.h / 2})`}
            textAnchor="middle" fontSize={12} fontWeight={500} fill={fg}>{yLabel}</text>
        </svg>
      </div>
    </div>
  )
}

function flagColor(flag: string | null) {
  if (!flag) return 'hsl(var(--chart-3))'
  if (flag.includes('GROWTH')) return 'oklch(0.65 0.18 250)'
  if (flag.includes('OVERVALUED')) return 'oklch(0.62 0.22 25)'
  if (flag.includes('UNDERVALUED')) return 'oklch(0.72 0.2 145)'
  return 'oklch(0.78 0.16 85)'
}

function flagLabel(flag: string | null): string {
  if (!flag) return 'Unknown'
  if (flag.includes('GROWTH')) return 'Growth Buy'
  if (flag.includes('OVERVALUED')) return 'Overvalued'
  if (flag.includes('UNDERVALUED')) return 'Undervalued'
  return 'Fair'
}

function matchesValuation(c: CardRow, v: DashboardPrefs['valuation']): boolean {
  const f = c.valuation_flag ?? ''
  if (v === 'all') return true
  if (v === 'under') return f.includes('UNDERVALUED')
  if (v === 'over') return f.includes('OVERVALUED')
  if (v === 'growth') return f.includes('GROWTH')
  return f.includes('FAIRLY') || (!f.includes('UNDER') && !f.includes('OVER') && !f.includes('GROWTH'))
}

export function Dashboard() {
  const queryClient = useQueryClient()
  const [fullRefreshBusy, setFullRefreshBusy] = useState(false)
  const [fullRefreshMsg, setFullRefreshMsg] = useState<string | null>(null)

  const [dashPrefs, setDashPrefs] = useState<DashboardPrefs>(() => loadDashboardPrefs())
  const [selectedId, _setSelectedId] = useState<string | null>(() => loadDashboardPrefs().selectedId)
  const setSelectedId = useCallback((v: string | null | ((prev: string | null) => string | null)) => {
    _setSelectedId((prev) => {
      const next = typeof v === 'function' ? v(prev) : v
      saveDashboardPrefs({ ...loadDashboardPrefs(), selectedId: next })
      return next
    })
  }, [])
  const [hovered, setHovered] = useState<{ id: string; cx: number; cy: number } | null>(null)
  const chartRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    saveDashboardPrefs(dashPrefs)
  }, [dashPrefs])

  const qDash = useQuery({
    queryKey: ['api', 'dashboard'],
    queryFn: () => api<DashKpis>('/api/dashboard'),
    staleTime: 30_000,
  })
  const qCards = useQuery({
    queryKey: ['api', 'cards', 'dashboard'],
    queryFn: () => api<CardsListResponse>('/api/cards?limit=5000&offset=0&slim=1'),
    staleTime: 60_000,
  })
  // Pulse data is folded into social momentum via card-level reddit_buzz_score
  const qUpcoming = useQuery({
    queryKey: ['api', 'upcoming'],
    queryFn: () =>
      api<{ id: string; name: string; release_date: string }[]>('/api/upcoming').catch(() => []),
    staleTime: 60_000,
  })
  const qMeta = useQuery({
    queryKey: ['api', 'meta', 'card-filters', ''],
    queryFn: () =>
      api<CardFiltersMeta>('/api/meta/card-filters').catch(() => ({
        sets: [],
        setIds: [],
        printBuckets: [],
      })),
    staleTime: 60_000,
  })
  const qSets = useQuery({
    queryKey: ['api', 'sets'],
    queryFn: () => api<SetRipRow[]>('/api/sets').catch(() => []),
    staleTime: 60_000,
  })

  const kpis = qDash.data ?? null
  const cards = qCards.data?.items ?? []
  
  const upcoming = qUpcoming.data ?? []
  const meta = qMeta.data ?? null
  const ripSets = qSets.data ?? []

  const error = qDash.error?.message ?? qCards.error?.message ?? null

  const lastLoaded = useMemo(() => {
    const t = Math.max(
      qDash.dataUpdatedAt,
      qCards.dataUpdatedAt,
      qUpcoming.dataUpdatedAt,
      qMeta.dataUpdatedAt,
      qSets.dataUpdatedAt,
    )
    return t > 0 ? new Date(t) : null
  }, [
    qDash.dataUpdatedAt,
    qCards.dataUpdatedAt,
    qUpcoming.dataUpdatedAt,
    qMeta.dataUpdatedAt,
    qSets.dataUpdatedAt,
  ])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const reloadDashboardData = () => {
    void queryClient.invalidateQueries({ queryKey: ['api'] })
  }

  const handleDotSelect = useCallback((id: string) => {
    setSelectedId((prev) => (prev != null && String(prev) === id ? null : id))
  }, [])
  const handleDotHover = useCallback((id: string, e: React.MouseEvent) => {
    if (!chartRef.current) return
    const r = chartRef.current.getBoundingClientRect()
    setHovered({ id, cx: e.clientX - r.left, cy: e.clientY - r.top })
  }, [])
  const handleDotLeave = useCallback(() => {
    setHovered(null)
  }, [])

  const runFullRefresh = async () => {
    if (!window.confirm('Run a full ingest + model refresh? This can take several minutes.')) return
    setFullRefreshBusy(true)
    setFullRefreshMsg(null)
    try {
      await api<{ ok: boolean }>('/api/internal/refresh', { method: 'POST' })
      setFullRefreshMsg('Refresh completed. Data reloaded.')
      await queryClient.invalidateQueries({ queryKey: ['api'] })
    } catch (e: unknown) {
      setFullRefreshMsg(e instanceof Error ? e.message : 'Refresh failed')
    } finally {
      setFullRefreshBusy(false)
    }
  }

  /** Cards that pass set + valuation + minimum fair value (your “noise floor”). */
  const filteredCards = useMemo(() => {
    let list = cards.filter((c) => passesMinFair(c, dashPrefs.minFairValueUsd))
    if (dashPrefs.scatterSetId) list = list.filter((c) => c.set_id === dashPrefs.scatterSetId)
    list = list.filter((c) => matchesValuation(c, dashPrefs.valuation))
    return list
  }, [cards, dashPrefs.scatterSetId, dashPrefs.valuation, dashPrefs.minFairValueUsd])

  const filteredForScatter = useMemo(() => {
    const scored = filteredCards.filter(
      (c) => c.pull_cost_score != null && c.desirability_score != null,
    )
    const priority = (f: string | null) => {
      if (f?.includes('UNDERVALUED')) return 0
      if (f?.includes('GROWTH')) return 1
      if (f?.includes('OVERVALUED')) return 3
      return 2
    }
    scored.sort((a, b) => priority(a.valuation_flag) - priority(b.valuation_flag))
    return scored
  }, [filteredCards])

  const scatterData: ScatterPt[] = useMemo(() => {
    const pts = filteredForScatter.slice(0, 500).map((c) => ({
      x: c.pull_cost_score ?? 0,
      y: c.desirability_score ?? 0,
      z: Math.max(1, c.predicted_price ?? c.market_price ?? 1),
      name: c.name,
      flag: c.valuation_flag,
      id: c.id,
      set_id: c.set_id,
      market: c.market_price,
      predicted: c.predicted_price,
      dealPct: dealPct(c),
    }))
    const renderPriority = (f: string | null) => {
      if (f?.includes('UNDERVALUED')) return 3
      if (f?.includes('GROWTH')) return 2
      if (f?.includes('OVERVALUED')) return 0
      return 1
    }
    pts.sort((a, b) => renderPriority(a.flag) - renderPriority(b.flag))
    return pts
  }, [filteredForScatter])

  const fairMarketData: ScatterPt[] = useMemo(() => {
    const pts = filteredCards
      .filter((c) => (c.market_price ?? 0) > 0 && (c.predicted_price ?? 0) > 0)
      .slice(0, 500)
      .map((c) => ({
        x: c.market_price ?? 0,
        y: c.predicted_price ?? 0,
        z: Math.max(1, c.predicted_price ?? c.market_price ?? 1),
        name: c.name,
        flag: c.valuation_flag,
        id: c.id,
        set_id: c.set_id,
        market: c.market_price,
        predicted: c.predicted_price,
        dealPct: dealPct(c),
      }))
    const renderPriority = (f: string | null) => {
      if (f?.includes('UNDERVALUED')) return 3
      if (f?.includes('GROWTH')) return 2
      if (f?.includes('OVERVALUED')) return 0
      return 1
    }
    pts.sort((a, b) => renderPriority(a.flag) - renderPriority(b.flag))
    return pts
  }, [filteredCards])

  const fairMarketMax = useMemo(() => {
    let m = 10
    for (const p of fairMarketData) {
      m = Math.max(m, p.x, p.y)
    }
    return Math.max(20, m * 1.06)
  }, [fairMarketData])

  const scatterDomains = useMemo((): { x: [number, number]; y: [number, number] } => {
    if (!scatterData.length) return { x: [0, 11], y: [0, 11] }
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity
    for (const d of scatterData) {
      if (d.x < xMin) xMin = d.x
      if (d.x > xMax) xMax = d.x
      if (d.y < yMin) yMin = d.y
      if (d.y > yMax) yMax = d.y
    }
    return { x: [xMin - 0.5, xMax + 0.5], y: [yMin - 0.5, yMax + 0.5] }
  }, [scatterData])

  const dealHistogram = useMemo(() => {
    const discs: number[] = []
    for (const c of filteredCards) {
      const d = dealPct(c)
      if (d != null && d > 0) discs.push(d)
    }
    let b0 = 0,
      b1 = 0,
      b2 = 0,
      b3 = 0
    for (const d of discs) {
      if (d < 5) b0++
      else if (d < 10) b1++
      else if (d < 20) b2++
      else b3++
    }
    return [
      { label: '0–5%', count: b0, hint: 'Slight edge' },
      { label: '5–10%', count: b1, hint: 'Noticeable' },
      { label: '10–20%', count: b2, hint: 'Strong' },
      { label: '20%+', count: b3, hint: 'Rare gap' },
    ]
  }, [filteredCards])

  const setsDealRank = useMemo(() => {
    const minD = dashPrefs.minDealPercent
    const tally = new Map<string, { n: number; sum: number }>()
    for (const c of filteredCards) {
      const d = dealPct(c)
      if (d == null || d < minD) continue
      if (!c.set_id) continue
      const t = tally.get(c.set_id) ?? { n: 0, sum: 0 }
      t.n += 1
      t.sum += d
      tally.set(c.set_id, t)
    }
    const rows = [...tally.entries()]
      .map(([id, { n, sum }]) => ({
        id,
        label: meta?.sets?.find((s) => s.id === id)?.name ?? id,
        count: n,
        avg: n ? sum / n : 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12)
    return rows
  }, [filteredCards, dashPrefs.minDealPercent, meta?.sets])

  const ripOutlook = useMemo(() => {
    let buySingles = 0
    let dontRip = 0
    let neutral = 0
    for (const s of ripSets) {
      const k = classifyRipVerdict(s.rip_or_singles_verdict)
      if (k === 'buy_singles') buySingles++
      else if (k === 'rip') dontRip++
      else neutral++
    }
    return { buySingles, dontRip, neutral, total: ripSets.length }
  }, [ripSets])

  const chartMeta = useMemo(
    () => CHART_CHOICES.find((c) => c.value === dashPrefs.chartKind) ?? CHART_CHOICES[0],
    [dashPrefs.chartKind],
  )

  const movers = useMemo(() => buildSocialMomentumRows(cards), [cards])
  const maxMomentum = movers[0]?.momentumScore ?? 0
  const hasDealMixData = useMemo(() => dealHistogram.some((b) => b.count > 0), [dealHistogram])

  const topOpportunities = useMemo(() => {
    const minD = dashPrefs.minDealPercent
    const minF = dashPrefs.minFairValueUsd
    return [...cards]
      .filter((c) => c.valuation_flag?.includes('UNDERVALUED') && c.predicted_price && c.market_price)
      .filter((c) => passesMinFair(c, minF))
      .map((c) => {
        const fair = c.predicted_price ?? 0
        const mkt = c.market_price ?? 0
        const disc = fair > 0 ? ((fair - mkt) / fair) * 100 : 0
        return { card: c, disc }
      })
      .filter(({ disc }) => disc >= minD)
      .sort((a, b) => b.disc - a.disc)
      .slice(0, 8)
  }, [cards, dashPrefs.minDealPercent, dashPrefs.minFairValueUsd])

  const topGrowth = useMemo(() => {
    return [...cards]
      .filter(
        (c) =>
          (c.valuation_flag?.includes('GROWTH') || (c.annual_growth_rate ?? 0) >= 0.10) &&
          (c.market_price ?? 0) > 0 &&
          (c.future_value_12m ?? 0) > 0,
      )
      .sort((a, b) => (b.annual_growth_rate ?? 0) - (a.annual_growth_rate ?? 0))
      .slice(0, 8)
  }, [cards])

  const selectedCard = useMemo(() => {
    if (selectedId == null) return undefined
    return cards.find((c) => String(c.id) === String(selectedId))
  }, [cards, selectedId])

  const cardsLink = (partial: Partial<CardsFiltersPersisted>): string => {
    const base: CardsFiltersPersisted = {
      q: '',
      set_id: '',
      print: '',
      sort: 'market_price',
      order: 'desc',
      flagFilter: '',
      ...partial,
    }
    return `/cards?${cardsFiltersToSearchParams(base).toString()}`
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
        <p className="font-medium text-destructive-foreground">{error}</p>
        <Button type="button" variant="secondary" className="mt-3" onClick={reloadDashboardData}>
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4 sm:space-y-6 lg:space-y-8">
      <section className="flex flex-col gap-4 rounded-xl border border-border bg-card/50 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-1">
            <h1 className="text-lg font-semibold tracking-tight">Overview</h1>
            <HelpButton sectionId="dashboard-overview" />
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Use filters and chart modes to explore current opportunities.</p>
          {lastLoaded && (
            <p className="mt-2 text-xs text-muted-foreground">
              Last loaded {lastLoaded.toLocaleTimeString()}
              {typeof navigator !== 'undefined' && !navigator.onLine ? ' · offline' : ''}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={reloadDashboardData}
            disabled={qDash.isFetching}
          >
            Reload data
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={runFullRefresh} disabled={fullRefreshBusy}>
            {fullRefreshBusy ? 'Refreshing…' : 'Full API refresh'}
          </Button>
        </div>
      </section>
      {fullRefreshMsg && (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {fullRefreshMsg}
        </p>
      )}

      <nav className="flex flex-wrap gap-2" aria-label="Quick navigation">
        {(
          [
            ['/cards', 'Browse cards'],
            ['/signals', 'Buy signals'],
            ['/sets', 'Sets & rip guide'],
            ['/watchlist', 'Watchlist'],
            ['/card-show', 'Card Show'],
          ] as const
        ).map(([to, label]) => (
          <Link
            key={to}
            to={to}
            className="inline-flex items-center rounded-full border border-border bg-background px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
          >
            {label}
          </Link>
        ))}
      </nav>

      {qDash.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-lg border border-border bg-muted/40" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiLink
              to="/cards"
              title="Total cards tracked"
              value={kpis?.totalCards ?? '—'}
              hint="Cards ingested from PokémonTCG.io — open full catalog"
            />
            <KpiLink
              to="/signals"
              title="Undervalued signals"
              value={kpis?.undervaluedSignals ?? '—'}
              hint="Cards flagged below model fair value — open buy signals"
            />
            <Kpi
              title="Avg model R²"
              value={kpis ? kpis.avgModelAccuracy.toFixed(2) : '—'}
              hint="Calibration quality (target ~0.88)"
            />
            <KpiLink
              to="/watchlist"
              title="Portfolio value"
              value={kpis ? `$${kpis.portfolioValue.toFixed(0)}` : '—'}
              hint="Watchlist × latest market — manage holdings"
            />
          </div>

          <DashboardWhyPanel
            undervaluedCount={kpis?.undervaluedSignals ?? 0}
            totalCards={kpis?.totalCards ?? 0}
            ripOutlook={ripOutlook}
          />
        </>
      )}

      {qCards.isPending || qMeta.isPending ? (
        <div className="h-[460px] animate-pulse rounded-xl border border-border bg-muted/40" />
      ) : (
      <div className="grid gap-3 sm:gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader className="space-y-1">
            <div className="flex items-center gap-1">
              <CardTitle>{chartMeta.label}</CardTitle>
              <HelpButton sectionId="dashboard-chart-panel" />
            </div>
            <CardDescription>{chartMeta.blurb}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:flex sm:flex-wrap sm:items-end">
              <div className="flex flex-col gap-1">
                <Label htmlFor="dash-chart-kind">Chart type</Label>
                <select
                  id="dash-chart-kind"
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm sm:w-auto sm:min-w-[12rem] sm:max-w-[min(100vw,22rem)]"
                  value={dashPrefs.chartKind}
                  onChange={(e) =>
                    setDashPrefs((p) => ({ ...p, chartKind: e.target.value as DashboardChartKind }))
                  }
                >
                  {CHART_CHOICES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="dash-set">Set filter</Label>
                <select
                  id="dash-set"
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm sm:w-auto sm:min-w-[10rem] sm:max-w-[min(100vw,18rem)]"
                  value={dashPrefs.scatterSetId}
                  onChange={(e) => setDashPrefs((p) => ({ ...p, scatterSetId: e.target.value }))}
                >
                  <option value="">All sets</option>
                  {(meta?.sets ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.id} — {s.name ?? s.id}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="dash-val">Valuation</Label>
                <select
                  id="dash-val"
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                  value={dashPrefs.valuation}
                  onChange={(e) =>
                    setDashPrefs((p) => ({
                      ...p,
                      valuation: e.target.value as DashboardPrefs['valuation'],
                    }))
                  }
                >
                  <option value="all">All</option>
                  <option value="under">Undervalued</option>
                  <option value="growth">Growth Buy</option>
                  <option value="over">Overvalued</option>
                  <option value="fair">Fairly valued</option>
                </select>
              </div>
            </div>

            <details className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm">
              <summary className="cursor-pointer font-medium text-foreground">
                Fine-tune what counts as a &quot;deal&quot; (your view only)
              </summary>
              <p className="mt-2 text-xs text-muted-foreground">
                These sliders do not retrain the model. They hide noisy cheap cards and dim dots that don&apos;t meet
                your personal bar so the chart matches how you shop.
              </p>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium">
                    Minimum % below model fair: <strong>{dashPrefs.minDealPercent}%</strong>
                  </span>
                  <span className="text-[0.7rem] text-muted-foreground">
                    Dots below this look faded; the &quot;Sets with deals&quot; chart counts only cards at or above this
                    gap.
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={40}
                    step={1}
                    value={dashPrefs.minDealPercent}
                    onChange={(e) =>
                      setDashPrefs((p) => ({ ...p, minDealPercent: Number(e.target.value) }))
                    }
                    className="w-full accent-primary"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium">
                    Ignore cards under: <strong>${dashPrefs.minFairValueUsd.toFixed(0)}</strong> model price
                  </span>
                  <span className="text-[0.7rem] text-muted-foreground">
                    Filters out bulk commons where a few cents looks like a huge % off.
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={50}
                    step={1}
                    value={dashPrefs.minFairValueUsd}
                    onChange={(e) =>
                      setDashPrefs((p) => ({ ...p, minFairValueUsd: Number(e.target.value) }))
                    }
                    className="w-full accent-primary"
                  />
                </label>
                <div className="sm:col-span-2">
                  <span className="text-xs font-medium">Bubble size on scatter charts</span>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {(
                      [
                        ['s', 'Smaller'],
                        ['m', 'Normal'],
                        ['l', 'Larger'],
                      ] as const
                    ).map(([k, lab]) => (
                      <Button
                        key={k}
                        type="button"
                        size="sm"
                        variant={dashPrefs.bubbleScale === k ? 'secondary' : 'outline'}
                        className="h-8"
                        onClick={() => setDashPrefs((p) => ({ ...p, bubbleScale: k }))}
                      >
                        {lab}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            </details>

            <p className="text-xs text-muted-foreground">
              {dashPrefs.chartKind === 'pull_desire' &&
                `Plotting ${scatterData.length} point${scatterData.length === 1 ? '' : 's'} (${filteredForScatter.length} with scores). `}
              {dashPrefs.chartKind === 'fair_market' &&
                `Plotting ${fairMarketData.length} priced cards (${filteredCards.length} after filters). `}
              {dashPrefs.chartKind === 'deal_mix' &&
                `Using ${filteredCards.length} cards after filters (needs both list and model prices). `}
              {dashPrefs.chartKind === 'sets_rank' &&
                `Ranking expansions by count of cards with ≥${dashPrefs.minDealPercent}% gap vs model. `}
              {filteredCards.length} cards match filters.
            </p>

            {(dashPrefs.chartKind === 'pull_desire' || dashPrefs.chartKind === 'fair_market') && (
              <div className="flex flex-wrap gap-4 text-xs">
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full bg-[oklch(0.72_0.2_145)]" />
                  Undervalued
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full bg-[oklch(0.65_0.18_250)]" />
                  Growth Buy
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full bg-[oklch(0.78_0.16_85)]" />
                  Fair
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full bg-[oklch(0.62_0.22_25)]" />
                  Overvalued
                </span>
                <span className="text-muted-foreground">
                  Faded dots are below your {dashPrefs.minDealPercent}% deal bar (still visible for context).
                </span>
              </div>
            )}

            <div className="chart-surface overflow-hidden rounded-xl border border-border/80 bg-card shadow-sm ring-1 ring-border/40">
              <div
                ref={chartRef}
                className="relative h-[300px] w-full min-w-0 overflow-hidden sm:h-[360px] md:h-[420px]"
              >
              {dashPrefs.chartKind === 'pull_desire' &&
                (scatterData.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">
                    No points match your filters. Try clearing the set filter, choose All valuations, or lower the
                    minimum model price.
                  </p>
                ) : (
                  <RawScatter
                    data={scatterData}
                    xDomain={scatterDomains.x}
                    yDomain={scatterDomains.y}
                    xLabel="Pull cost (1–10)"
                    yLabel="Desirability (1–10)"
                    xFmt={formatScoreAxis}
                    yFmt={formatScoreAxis}
                    selectedId={selectedId}
                    minDealPercent={dashPrefs.minDealPercent}
                    zRange={bubbleZRange(dashPrefs.bubbleScale)}
                    onSelect={handleDotSelect}
                    onHover={handleDotHover}
                    onLeave={handleDotLeave}
                    quadrants
                    refX={5.5}
                    refY={5.5}
                  />
                ))}

              {dashPrefs.chartKind === 'fair_market' &&
                (fairMarketData.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">
                    No cards with both a list price and model price. Run ingest or widen filters.
                  </p>
                ) : (
                  <RawScatter
                    data={fairMarketData}
                    xDomain={[0, fairMarketMax]}
                    yDomain={[0, fairMarketMax]}
                    xLabel="Listed price"
                    yLabel="Model fair value"
                    xFmt={formatUsdAxis}
                    yFmt={formatUsdAxis}
                    selectedId={selectedId}
                    minDealPercent={dashPrefs.minDealPercent}
                    zRange={bubbleZRange(dashPrefs.bubbleScale)}
                    onSelect={handleDotSelect}
                    onHover={handleDotHover}
                    onLeave={handleDotLeave}
                    diag
                  />
                ))}

              {(dashPrefs.chartKind === 'pull_desire' || dashPrefs.chartKind === 'fair_market') && hovered && (
                <HoverLabel
                  data={
                    dashPrefs.chartKind === 'pull_desire'
                      ? scatterData
                      : fairMarketData
                  }
                  hovered={hovered}
                  mode={dashPrefs.chartKind === 'pull_desire' ? 'pull' : 'fair_market'}
                  containerRef={chartRef}
                />
              )}

              {dashPrefs.chartKind === 'deal_mix' &&
                (hasDealMixData ? (
                  <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
                    <BarChart data={dealHistogram} margin={{ top: 20, right: 16, bottom: 36, left: 12 }}>
                      <CartesianGrid stroke="hsl(var(--foreground))" strokeDasharray="3 6" strokeOpacity={0.18} />
                      <XAxis
                        dataKey="label"
                        tick={{ fontSize: 12, fill: 'hsl(var(--foreground))' }}
                        stroke="hsl(var(--foreground))"
                      />
                      <YAxis
                        allowDecimals={false}
                        tickFormatter={formatCountAxis}
                        tick={{ fontSize: 12, fill: 'hsl(var(--foreground))' }}
                        stroke="hsl(var(--foreground))"
                        label={{
                          value: 'Card count',
                          angle: -90,
                          position: 'insideLeft',
                          fontSize: 12,
                          fill: 'hsl(var(--foreground))',
                        }}
                      />
                      <Tooltip
                        animationDuration={100}
                        wrapperStyle={{ pointerEvents: 'auto' }}
                        content={({ active, payload }) =>
                          active && payload?.[0] ? (
                            <div
                              className="pointer-events-auto max-w-xs rounded-lg border border-border/90 bg-popover px-3 py-2 text-xs shadow-lg ring-1 ring-black/5 dark:ring-white/10"
                              onPointerDown={(e) => e.stopPropagation()}
                            >
                              <p className="font-semibold text-foreground">{String(payload[0].payload.label)}</p>
                              <p className="mt-1 text-muted-foreground">{payload[0].payload.hint}</p>
                              <p className="mt-1.5 tabular-nums text-foreground">{payload[0].value} cards</p>
                            </div>
                          ) : null
                        }
                      />
                      <Bar dataKey="count" radius={[6, 6, 0, 0]} maxBarSize={72}>
                        {dealHistogram.map((_, i) => (
                          <Cell key={i} fill={`hsl(var(--chart-${(i % 5) + 1}))`} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="p-4 text-sm text-muted-foreground">
                    No cards are currently priced below model fair value after filters. Try lowering minimum fair value,
                    widening valuation filters, or running a refresh.
                  </p>
                ))}

              {dashPrefs.chartKind === 'sets_rank' &&
                (setsDealRank.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No sets have enough singles over your {dashPrefs.minDealPercent}% deal bar with current filters. Try
                    lowering the minimum deal % or set the valuation filter to All.
                  </p>
                ) : (
                  <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
                    <BarChart
                      layout="vertical"
                      data={setsDealRank}
                      margin={{ top: 12, right: 16, bottom: 32, left: 4 }}
                    >
                      <CartesianGrid
                        stroke="hsl(var(--border))"
                        strokeDasharray="4 6"
                        strokeOpacity={0.4}
                        horizontal={false}
                      />
                      <XAxis
                        type="number"
                        allowDecimals={false}
                        tickFormatter={formatCountAxis}
                        tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                        stroke="hsl(var(--border))"
                        label={{
                          value: 'Cards meeting your deal bar',
                          position: 'bottom',
                          offset: 12,
                          fontSize: 12,
                          fill: 'hsl(var(--muted-foreground))',
                        }}
                      />
                      <YAxis
                        type="category"
                        dataKey="label"
                        width={100}
                        tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
                        stroke="hsl(var(--border))"
                        tickFormatter={(v: string) => (v.length > 16 ? `${v.slice(0, 14)}…` : v)}
                      />
                      <Tooltip
                        animationDuration={100}
                        wrapperStyle={{ pointerEvents: 'auto' }}
                        content={({ active, payload }) =>
                          active && payload?.[0] ? (
                            <div
                              className="pointer-events-auto max-w-xs rounded-lg border border-border/90 bg-popover px-3 py-2 text-xs shadow-lg ring-1 ring-black/5 dark:ring-white/10"
                              onPointerDown={(e) => e.stopPropagation()}
                            >
                              <p className="font-semibold text-foreground">{payload[0].payload.label}</p>
                              <p className="mt-0.5 text-[0.65rem] text-muted-foreground">{payload[0].payload.id}</p>
                              <p className="mt-2 tabular-nums text-foreground">
                                {payload[0].value} cards · avg gap {payload[0].payload.avg.toFixed(0)}%
                              </p>
                            </div>
                          ) : null
                        }
                      />
                      <Bar dataKey="count" radius={[0, 6, 6, 0]} maxBarSize={28}>
                        {setsDealRank.map((_, i) => (
                          <Cell key={i} fill={`hsl(var(--chart-${(i % 3) + 2}))`} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="flex flex-col">
          <CardHeader>
            <CardTitle className="text-base">Pinned card</CardTitle>
            <CardDescription>
              Click any bubble on a scatter chart to pin it here. Hover for a quick label. Press Esc to clear.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-3">
            {!selectedCard ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/20 p-6 text-center">
                <span className="text-3xl opacity-40">📌</span>
                <p className="text-sm text-muted-foreground">
                  Click a point on the chart to see card details, prices, and links here.
                </p>
              </div>
            ) : (
              <>
                {selectedCard.image_url && (
                  <img
                    src={selectedCard.image_url}
                    alt=""
                    className="mx-auto max-h-44 rounded-lg border border-border object-contain shadow-sm"
                  />
                )}
                <div>
                  <p className="text-base font-semibold leading-snug">{selectedCard.name}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Badge
                      variant="outline"
                      className={cn(
                        selectedCard.valuation_flag?.includes('UNDERVALUED') && 'border-emerald-500/50 text-emerald-600 dark:text-emerald-400',
                        selectedCard.valuation_flag?.includes('GROWTH') && 'border-sky-500/50 text-sky-600 dark:text-sky-400',
                        selectedCard.valuation_flag?.includes('OVERVALUED') && !selectedCard.valuation_flag?.includes('GROWTH') && 'border-red-500/50 text-red-600 dark:text-red-400',
                      )}
                    >
                      {flagLabel(selectedCard.valuation_flag)}
                    </Badge>
                    {selectedCard.set_id && (
                      <span className="text-xs text-muted-foreground">{selectedCard.set_id}</span>
                    )}
                  </div>
                </div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-md bg-muted/30 px-3 py-2 text-sm">
                  <dt className="text-muted-foreground">Pull</dt>
                  <dd className="tabular-nums font-medium">{selectedCard.pull_cost_score?.toFixed(1) ?? '—'}</dd>
                  <dt className="text-muted-foreground">Desire</dt>
                  <dd className="tabular-nums font-medium">{selectedCard.desirability_score?.toFixed(1) ?? '—'}</dd>
                  <dt className="text-muted-foreground">Model fair</dt>
                  <dd className="tabular-nums font-medium text-emerald-600 dark:text-emerald-400">
                    {selectedCard.predicted_price != null ? `$${selectedCard.predicted_price.toFixed(2)}` : '—'}
                  </dd>
                  <dt className="text-muted-foreground">Market</dt>
                  <dd className="tabular-nums font-medium text-sky-600 dark:text-sky-400">
                    {selectedCard.market_price != null ? `$${selectedCard.market_price.toFixed(2)}` : '—'}
                  </dd>
                  {selectedCard.future_value_12m != null && selectedCard.future_value_12m > 0 && (
                    <>
                      <dt className="text-muted-foreground">12m projected</dt>
                      <dd className="tabular-nums font-medium text-sky-600 dark:text-sky-400">
                        ${selectedCard.future_value_12m.toFixed(2)}
                      </dd>
                    </>
                  )}
                  {selectedCard.annual_growth_rate != null && selectedCard.annual_growth_rate > 0 && (
                    <>
                      <dt className="text-muted-foreground">Growth rate</dt>
                      <dd className="tabular-nums font-semibold text-sky-600 dark:text-sky-400">
                        +{(selectedCard.annual_growth_rate * 100).toFixed(0)}%
                      </dd>
                    </>
                  )}
                </dl>
                <Separator />
                <div className="flex flex-wrap gap-2">
                  <Link
                    className={cn(buttonVariants({ size: 'sm' }), 'flex-1')}
                    to={cardsLink({
                      q:
                        selectedCard.name.length > 48 ? selectedCard.name.slice(0, 48) : selectedCard.name,
                      sort: 'market_price',
                      order: 'desc',
                    })}
                  >
                    Open in Cards
                  </Link>
                  {selectedCard.set_id && (
                    <Link
                      className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}
                      to={cardsLink({ set_id: selectedCard.set_id, sort: 'market_price', order: 'desc' })}
                    >
                      Same set
                    </Link>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs text-muted-foreground"
                    onClick={() => setSelectedId(null)}
                  >
                    Clear
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
      )}

      <div className="grid gap-3 sm:gap-4 lg:grid-cols-2">
        {qCards.isPending ? (
          <div className="h-48 animate-pulse rounded-xl border border-border bg-muted/40" />
        ) : (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-1">
              <CardTitle className="text-base">Top undervalued picks</CardTitle>
              <HelpButton sectionId="dashboard-overview" />
            </div>
            <CardDescription>
              Largest gap vs market among cards flagged undervalued — respects your minimum deal % and minimum model
              price from the chart panel.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {topOpportunities.map(({ card, disc }) => (
                <li key={card.id}>
                  <button
                    type="button"
                    className="flex w-full items-start justify-between gap-2 rounded-md border border-transparent px-1 py-1.5 text-left transition-colors hover:border-border hover:bg-muted/50"
                    onClick={() => setSelectedId(card.id)}
                  >
                    <span className="font-medium leading-snug">{card.name}</span>
                    <span className="shrink-0 tabular-nums text-emerald-600 dark:text-emerald-400">
                      {disc.toFixed(0)}% off
                    </span>
                  </button>
                </li>
              ))}
              {!topOpportunities.length && (
                <li className="text-muted-foreground">
                  Nothing matches yet — lower the deal % / model price sliders above, clear filters, run ingest, or open{' '}
                  <Link className="text-primary underline" to="/signals">
                    Buy signals
                  </Link>{' '}
                  for the raw list.
                </li>
              )}
            </ul>
            <Link className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-4 inline-flex')} to="/signals">
              View all buy signals
            </Link>
          </CardContent>
        </Card>
        )}

        {qUpcoming.isPending ? (
          <div className="h-48 animate-pulse rounded-xl border border-border bg-muted/40" />
        ) : (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div className="flex items-center gap-1">
              <CardTitle className="text-base">Upcoming sets</CardTitle>
              <HelpButton sectionId="dashboard-overview" />
            </div>
            <Link className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'h-8 text-xs')} to="/sets">
              All sets
            </Link>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {upcoming.map((u) => (
                <li key={u.id} className="flex justify-between gap-2 border-b border-border py-2 last:border-0">
                  <Link
                    to={cardsLink({ set_id: u.id, sort: 'market_price', order: 'desc' })}
                    className="font-medium text-primary hover:underline"
                  >
                    {u.name}
                  </Link>
                  <span className="shrink-0 text-muted-foreground">{u.release_date}</span>
                </li>
              ))}
              {!upcoming.length && <li className="text-muted-foreground">No upcoming rows (seed in API).</li>}
            </ul>
          </CardContent>
        </Card>
        )}
      </div>

      {qCards.isPending ? (
        <div className="h-48 animate-pulse rounded-xl border border-border bg-muted/40" />
      ) : topGrowth.length > 0 && (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-1">
            <CardTitle className="text-base">Growth opportunities</CardTitle>
            <HelpButton sectionId="dashboard-overview" />
          </div>
          <CardDescription>
            Cards with strong 12-month projected growth — may be overvalued today but attractive for long-term upside.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {topGrowth.map((c) => {
              const growth = (c.annual_growth_rate ?? 0) * 100
              const mkt = c.market_price ?? 0
              const proj = c.future_value_12m ?? 0
              const isGrowthFlag = c.valuation_flag?.includes('GROWTH')
              return (
                <button
                  key={c.id}
                  type="button"
                  className="flex flex-col gap-1.5 rounded-lg border border-border p-3 text-left transition-colors hover:border-sky-400/50 hover:bg-sky-50/50 dark:hover:bg-sky-950/20"
                  onClick={() => setSelectedId(c.id)}
                >
                  <span className="text-sm font-medium leading-snug line-clamp-2">{c.name}</span>
                  <div className="flex items-center gap-1.5">
                    {isGrowthFlag && (
                      <span className="inline-flex items-center gap-0.5 rounded bg-sky-500/15 px-1.5 py-0.5 text-[0.65rem] font-semibold text-sky-700 ring-1 ring-inset ring-sky-500/25 dark:text-sky-400">
                        ⬆ Growth Buy
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">{c.set_id}</span>
                  </div>
                  <div className="mt-auto flex items-baseline justify-between gap-2">
                    <div className="text-xs">
                      <span className="text-muted-foreground">Now </span>
                      <span className="font-medium tabular-nums">${mkt.toFixed(2)}</span>
                    </div>
                    <div className="text-right text-xs">
                      <span className="text-muted-foreground">12m </span>
                      <span className="font-semibold tabular-nums text-sky-600 dark:text-sky-400">${proj.toFixed(2)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 rounded-full bg-muted">
                      <div
                        className="h-1.5 rounded-full bg-sky-500/70 transition-all"
                        style={{ width: `${Math.min(100, growth)}%` }}
                      />
                    </div>
                    <span className="text-xs font-semibold tabular-nums text-sky-600 dark:text-sky-400">
                      +{growth.toFixed(0)}%
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        </CardContent>
      </Card>
      )}

      {qCards.isPending ? (
        <div className="grid gap-3 sm:gap-4 lg:grid-cols-2">
          <div className="h-64 animate-pulse rounded-xl border border-border bg-muted/40" />
          <div className="h-64 animate-pulse rounded-xl border border-border bg-muted/40" />
        </div>
      ) : (
      <div className="grid gap-3 sm:gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-1">
              <CardTitle className="text-base">Social momentum</CardTitle>
              <HelpButton sectionId="dashboard-social-momentum" />
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {movers.length > 0 && (
              <div className="flex items-center justify-between px-1.5 text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">
                <span>Name</span>
                <span>Momentum</span>
              </div>
            )}
            <div className="space-y-1.5">
              {movers.map((m) => {
                const pct = maxMomentum > 0 ? Math.min(100, Math.round((m.momentumScore / maxMomentum) * 100)) : 0
                const score = Math.round(m.momentumScore * 100)
                const fair = m.predictedPrice ?? 0
                const mkt = m.marketPrice ?? 0
                const gap = fair > 0 && mkt > 0 ? ((fair - mkt) / fair) * 100 : 0
                return (
                  <Link
                    key={m.id}
                    to={cardsLink({
                      q: m.name.length > 40 ? m.name.slice(0, 40) : m.name,
                      sort: 'market_price',
                      order: 'desc',
                    })}
                    className="group flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-muted"
                    title={`Momentum ${score}/100 — blends Reddit buzz and Google Trends. Bar shows relative strength vs. top card in this list.`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-1">
                        <span className="truncate text-sm font-medium">{m.name}</span>
                        <span className={cn(
                          'shrink-0 text-xs tabular-nums font-medium',
                          gap > 5 ? 'text-emerald-600 dark:text-emerald-400' : gap < -5 ? 'text-red-500' : 'text-muted-foreground',
                        )}>
                          {mkt > 0 ? `$${mkt.toFixed(0)}` : '—'}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2">
                        <div className="h-1.5 flex-1 rounded-full bg-muted">
                          <div
                            className="h-1.5 rounded-full bg-primary/70 transition-all"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="w-12 text-right text-[0.65rem] tabular-nums text-muted-foreground">
                          {score}/100
                        </span>
                      </div>
                    </div>
                  </Link>
                )
              })}
              {!movers.length && (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  Waiting for social signals (Reddit and trends)…
                </p>
              )}
            </div>
            <p className="text-[0.65rem] text-muted-foreground">
              Momentum score (0–100) blends Reddit buzz and Google Trends. Bar shows relative strength vs. top card. Deduplicated by character.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-1">
              <CardTitle className="text-base">Model pipeline</CardTitle>
              <HelpButton sectionId="dashboard-model-pipeline" />
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <ModelPipelineDiagram cards={cards} />
            <div className="rounded-md border border-border bg-muted/20 p-2.5">
              <p className="text-xs font-medium text-foreground">Confidence note</p>
              <p className="mt-1 text-[0.65rem] leading-relaxed text-muted-foreground">
                Fair value is a <strong>heuristic blend</strong> of pull cost, desirability, peer tier median, and market
                anchoring — not a guarantee. The model caps predictions within 3× market and 3.5× peer median to prevent
                extreme outliers. Cards with no market data receive wider estimates.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
      )}
    </div>
  )
}

function HoverLabel({
  data,
  hovered,
  mode,
  containerRef,
}: {
  data: ScatterPt[]
  hovered: { id: string; cx: number; cy: number }
  mode: 'pull' | 'fair_market'
  containerRef?: React.RefObject<HTMLDivElement | null>
}) {
  const p = data.find((d) => d.id === hovered.id)
  if (!p) return null
  const left = hovered.cx
  const top = hovered.cy
  const cw = containerRef?.current?.clientWidth ?? 600
  const flipX = left > cw * 0.55
  const flipY = top < 60
  const label =
    mode === 'pull'
      ? `Pull ${p.x.toFixed(1)} · Desire ${p.y.toFixed(1)}`
      : `List ${formatUsdAxis(p.x)} · Fair ${formatUsdAxis(p.y)}`
  return (
    <div
      className="pointer-events-none absolute z-20 max-w-[14rem] rounded-lg border border-border/80 bg-popover/95 px-2.5 py-1.5 text-[0.7rem] text-popover-foreground shadow-lg backdrop-blur-sm transition-opacity"
      style={{
        left: flipX ? left - 8 : left + 14,
        top: flipY ? top + 14 : top - 8,
        transform: `translate(${flipX ? '-100%' : '0'}, ${flipY ? '0' : '-100%'})`,
      }}
    >
      <p className="font-semibold leading-snug">{p.name}</p>
      <p className="mt-0.5 text-muted-foreground">{label}</p>
      <p className="mt-1 tabular-nums">
        Fair <span className="text-emerald-600 dark:text-emerald-400">${p.predicted?.toFixed(2) ?? '—'}</span>
        {' · '}
        Mkt <span className="text-sky-600 dark:text-sky-400">${p.market?.toFixed(2) ?? '—'}</span>
      </p>
    </div>
  )
}

function DashboardWhyPanel({
  undervaluedCount,
  totalCards,
  ripOutlook,
}: {
  undervaluedCount: number
  totalCards: number
  ripOutlook: { buySingles: number; dontRip: number; neutral: number; total: number }
}) {
  const noSingles = ripOutlook.total > 0 && ripOutlook.buySingles === 0
  return (
    <div className="space-y-3 rounded-xl border border-border bg-muted/15 p-4 text-sm">
      <h2 className="font-semibold leading-tight">Making sense of &quot;no great buys&quot;</h2>
      <p className="text-muted-foreground">
        If buy signals or this page look empty, it doesn&apos;t always mean Pokémon is &quot;uninvestable&quot; — it
        often means the <strong>current filters</strong>, <strong>freshness of prices</strong>, or{' '}
        <strong>how strict the model is</strong> when comparing listings to fair value.
      </p>
      <ul className="list-inside list-disc space-y-1.5 text-muted-foreground">
        <li>
          <strong>Undervalued</strong> is a high bar: the model only flags cards where the listed price is clearly below
          its fair estimate. Most inventory sits at <strong>Fair</strong> after a refresh — that is normal.
        </li>
        <li>
          Market data can lag (TCGPlayer snapshots, stale singles). If nothing moves, try{' '}
          <strong>Full API refresh</strong> above after ingest.
        </li>
        <li>
          Your sliders (minimum deal %, minimum model price) intentionally hide noisy rows. If the chart looks empty,
          lower those slightly — they are <em>your</em> lens, not the backend math.
        </li>
      </ul>
      {undervaluedCount === 0 && totalCards > 0 && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
          Right now the API reports <strong>0</strong> cards tagged undervalued out of {totalCards} tracked. That
          usually means listings are close to the model — not that every card is a bad purchase.
        </p>
      )}
      {ripOutlook.total > 0 && (
        <div className="rounded-md border border-border bg-background/80 px-3 py-2 text-xs">
          <p className="font-medium text-foreground">Booster / rip guide (heuristic)</p>
          <p className="mt-1 text-muted-foreground">
            From ingested set data:{' '}
            <strong className="text-foreground">{ripOutlook.buySingles}</strong> sets lean toward buying singles,{' '}
            <strong className="text-foreground">{ripOutlook.dontRip}</strong> lean toward skipping boxes for value,{' '}
            <strong className="text-foreground">{ripOutlook.neutral}</strong> mixed or unknown.
          </p>
          {noSingles && (
            <p className="mt-2 text-muted-foreground">
              None of the loaded sets currently show the &quot;buy singles&quot; stamp. That uses rough EV vs box and
              chase scores — not live sealed prices — so it can look harsh when margins are tight everywhere. Check the{' '}
              <Link className="text-primary underline" to="/sets">
                Sets
              </Link>{' '}
              page for per-set context.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function ModelPipelineDiagram({ cards }: { cards: CardRow[] }) {
  const stats = useMemo(() => {
    const withMarket = cards.filter((c) => c.market_price && c.market_price > 0)
    const withPredicted = cards.filter((c) => c.predicted_price && c.predicted_price > 0)
    const withBuzz = cards.filter((c) => c.reddit_buzz_score && c.reddit_buzz_score > 0)
    const under = cards.filter((c) => c.valuation_flag?.includes('UNDERVALUED'))
    const over = cards.filter((c) => c.valuation_flag?.includes('OVERVALUED'))
    const fair = cards.filter((c) => c.valuation_flag?.includes('FAIRLY'))
    const avgPull = withMarket.length
      ? withMarket.reduce((a, c) => a + (c.pull_cost_score ?? 5), 0) / withMarket.length
      : 5
    const avgDes = withMarket.length
      ? withMarket.reduce((a, c) => a + (c.desirability_score ?? 5), 0) / withMarket.length
      : 5
    return {
      total: cards.length,
      withMarket: withMarket.length,
      withPredicted: withPredicted.length,
      withBuzz: withBuzz.length,
      under: under.length,
      over: over.length,
      fair: fair.length,
      avgPull: avgPull.toFixed(1),
      avgDes: avgDes.toFixed(1),
    }
  }, [cards])

  const steps = [
    { label: 'Ingested', value: stats.total, color: 'bg-sky-500', hint: 'Cards from PokémonTCG.io API' },
    { label: 'Market price', value: stats.withMarket, color: 'bg-indigo-500', hint: 'Have a TCGPlayer listing' },
    { label: 'Model scored', value: stats.withPredicted, color: 'bg-violet-500', hint: 'Pull × Desirability → Fair value' },
    { label: 'Reddit buzz', value: stats.withBuzz, color: 'bg-amber-500', hint: 'Mentioned on r/PokemonTCG' },
  ]
  const pctPipeline = stats.total > 0 ? (stats.withPredicted / stats.total) * 100 : 0

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        {steps.map((s, i) => {
          const pct = stats.total > 0 ? Math.round((s.value / stats.total) * 100) : 0
          return (
            <div key={s.label} className="group">
              <div className="flex items-center gap-2">
                <div className="flex size-5 items-center justify-center rounded-full bg-muted text-[0.6rem] font-bold text-muted-foreground">
                  {i + 1}
                </div>
                <span className="flex-1 text-xs font-medium">{s.label}</span>
                <span className="tabular-nums text-xs text-muted-foreground">{s.value.toLocaleString()}</span>
              </div>
              <div className="ml-7 mt-0.5">
                <div className="h-1.5 rounded-full bg-muted">
                  <div className={cn('h-1.5 rounded-full transition-all', s.color)} style={{ width: `${pct}%` }} />
                </div>
                <p className="mt-0.5 text-[0.6rem] text-muted-foreground">{s.hint}</p>
              </div>
            </div>
          )
        })}
      </div>

      <div className="flex items-center gap-1 text-[0.6rem] text-muted-foreground">
        <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 1v14M1 8h14" /></svg>
        Avg pull {stats.avgPull}/10 · Avg desire {stats.avgDes}/10 · Coverage {pctPipeline.toFixed(0)}%
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-1.5 text-center">
          <p className="text-lg font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{stats.under}</p>
          <p className="text-[0.6rem] font-medium text-emerald-700 dark:text-emerald-300">Undervalued</p>
        </div>
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-center">
          <p className="text-lg font-semibold tabular-nums text-amber-600 dark:text-amber-400">{stats.fair}</p>
          <p className="text-[0.6rem] font-medium text-amber-700 dark:text-amber-300">Fair</p>
        </div>
        <div className="rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-center">
          <p className="text-lg font-semibold tabular-nums text-red-600 dark:text-red-400">{stats.over}</p>
          <p className="text-[0.6rem] font-medium text-red-700 dark:text-red-300">Overvalued</p>
        </div>
      </div>
    </div>
  )
}

function Kpi({ title, value, hint }: { title: string; value: string | number; hint?: string }) {
  return (
    <Card className="transition-shadow hover:shadow-md">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  )
}

function KpiLink({
  to,
  title,
  value,
  hint,
}: {
  to: string
  title: string
  value: string | number
  hint?: string
}) {
  return (
    <Link to={to} className={cn('block rounded-lg ring-offset-background transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none')}>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold tabular-nums text-primary">{value}</p>
          {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
        </CardContent>
      </Card>
    </Link>
  )
}
