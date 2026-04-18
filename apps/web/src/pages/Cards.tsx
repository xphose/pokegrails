import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useLocation, useSearchParams } from 'react-router-dom'
import {
  Area,
  AreaChart,
  Brush,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Label } from '@/components/ui/label'
import { AlertTriangle, ChevronDown, Eye, EyeOff } from 'lucide-react'
import {
  api,
  type CardFiltersMeta,
  type CardInvestmentInsight,
  type CardRow,
  type CardsListResponse,
  type SetMeta,
} from '@/lib/api'
import { UpgradeBanner } from '@/components/UpgradeBanner'
import { useAuth } from '@/lib/auth'
import { SetMetaTooltipBody, setHoverTitle } from '@/components/set-meta-tooltip'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  type ConditionCode,
  adjustPrice,
  CONDITION_LABELS,
  CONDITION_PCT,
  loadShowAdjusted,
  loadStoredCondition,
  saveShowAdjusted,
  saveStoredCondition,
} from '@/lib/condition'
import {
  cardsFiltersToSearchParams,
  getInitialCardsFilters,
  saveCardsFilters,
  searchParamsEqual,
  loadPsaGrade,
  savePsaGrade,
  loadTrendWindow,
  saveTrendWindow,
  type CardsFiltersPersisted,
  type PsaGradePersisted,
} from '@/lib/ui-persist'
import { HelpButton } from '@/components/help-center'
import { buildFullHistory, filterChartData, type TrendWindow as TrendWindowType } from '@/lib/chart-history'

/* ------------------------------------------------------------------ */
/*  Column visibility                                                  */
/* ------------------------------------------------------------------ */

type ColumnId =
  | 'name'
  | 'ai'
  | 'set_id'
  | 'card_type'
  | 'rarity'
  | 'pull'
  | 'desire'
  | 'predicted'
  | 'market'
  | 'gap'
  | 'ebay'
  | 'flag'
  | 'future'
  | 'spark'

const COLUMN_LABELS: Record<ColumnId, string> = {
  name: 'Card',
  ai: 'AI score',
  set_id: 'Set name',
  card_type: 'Print',
  rarity: 'Rarity',
  pull: 'Pull',
  desire: 'Desire',
  predicted: 'Model fair',
  market: 'Market',
  gap: 'vs model ($)',
  ebay: 'eBay',
  flag: 'Valuation',
  future: 'Forecast',
  spark: '30d trend',
}

const ALL_COLUMNS: ColumnId[] = Object.keys(COLUMN_LABELS) as ColumnId[]
const DEFAULT_VISIBLE = new Set<ColumnId>(ALL_COLUMNS)

const COL_VIS_KEY = 'pokegrails_cards_col_vis'

function loadColumnVisibility(): Set<ColumnId> {
  try {
    const raw = localStorage.getItem(COL_VIS_KEY)
    if (!raw) return new Set(DEFAULT_VISIBLE)
    const arr = JSON.parse(raw) as string[]
    const s = new Set<ColumnId>()
    for (const c of arr) if ((ALL_COLUMNS as string[]).includes(c)) s.add(c as ColumnId)
    return s.size > 0 ? s : new Set(DEFAULT_VISIBLE)
  } catch {
    return new Set(DEFAULT_VISIBLE)
  }
}

function saveColumnVisibility(vis: Set<ColumnId>) {
  try {
    localStorage.setItem(COL_VIS_KEY, JSON.stringify([...vis]))
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/*  Gap vs model — dollar amount (market − model fair)                 */
/*  Color uses normalized spread vs the larger price so tiny model $   */
/*  doesn’t explode into meaningless %s.                               */
/* ------------------------------------------------------------------ */

function gapDollars(predicted: number | null, market: number | null): number | null {
  if (predicted == null || market == null) return null
  return market - predicted
}

/** Positive = market asks more than model; negative = listing below model (deal). */
function formatGapDollars(usd: number | null): string {
  if (usd == null || !Number.isFinite(usd)) return '—'
  const abs = Math.abs(usd)
  const fmt = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: abs >= 100 ? 0 : 2,
    maximumFractionDigits: abs >= 100 ? 0 : 2,
  }).format(abs)
  if (usd > 0) return `+${fmt}`
  if (usd < 0) return `−${fmt}`
  return fmt
}

/**
 * How far apart are market and model in *relative* terms, using the larger $ as scale.
 * Always in [0, 1] when both positive; avoids absurd % when model fair is tiny.
 */
function gapNormalizedSpread(predicted: number | null, market: number | null): number | null {
  if (predicted == null || market == null) return null
  const denom = Math.max(Math.abs(predicted), Math.abs(market), 0.01)
  return (market - predicted) / denom
}

function gapDollarBadge(
  predicted: number | null,
  market: number | null,
): { label: string; className: string } {
  const usd = gapDollars(predicted, market)
  if (usd == null) return { label: '—', className: '' }
  const rel = gapNormalizedSpread(predicted, market)
  const label = formatGapDollars(usd)
  if (rel == null) return { label, className: '' }
  const r = Math.abs(rel)
  // Signed: positive rel = market above model (overvalued listing vs model)
  if (rel > 0.2) return { label, className: 'border-red-500/50 bg-red-500/10 text-red-700 dark:text-red-400' }
  if (rel > 0.06) return { label, className: 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400' }
  if (rel < -0.06) return { label, className: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' }
  if (r <= 0.06) return { label, className: 'border-border text-muted-foreground' }
  return { label, className: '' }
}

type Hist = { timestamp: string; tcgplayer_market: number | null }
type TrendWindow = TrendWindowType
type BrushRange = { startIndex: number; endIndex: number }

/**
 * The chart-level grade toggle is intentionally a subset of
 * `GRADE_OPTIONS` (defined at the bottom of this file for the ROI panel)
 * because we only have historical *series* for raw + PSA 9 / 9.5 / 10 and a
 * point-in-time reference for BGS 10. Grade 7 / 8 exist as point-in-time
 * values but aren't commonly plotted by collectors.
 *
 * Keys here match the server's `/api/cards/:id/history?grade=` values. Keep
 * in sync with `apps/server/src/app.ts` and the `card_grade_history.grade`
 * column.
 */
type ChartGradeKey = 'raw' | 'grade9' | 'grade95' | 'psa10' | 'bgs10'
type ChartSourceKey = 'both' | 'tcgplayer' | 'pricecharting'

const CHART_SOURCE_OPTIONS: { key: ChartSourceKey; label: string; long: string }[] = [
  { key: 'both', label: 'All', long: 'All sources (PC preferred on overlap)' },
  { key: 'pricecharting', label: 'PriceCharting', long: 'PriceCharting only' },
  { key: 'tcgplayer', label: 'TCGPlayer', long: 'TCGPlayer only (live ticks, outlier-gated)' },
]

const CHART_GRADE_OPTIONS: { key: ChartGradeKey; label: string; long: string }[] = [
  { key: 'raw',     label: 'Raw',     long: 'Raw (ungraded)' },
  { key: 'grade9',  label: 'PSA 9',   long: 'PSA 9' },
  { key: 'grade95', label: 'PSA 9.5', long: 'PSA 9.5' },
  { key: 'psa10',   label: 'PSA 10',  long: 'PSA 10' },
  { key: 'bgs10',   label: 'BGS 10',  long: 'BGS 10 (point-in-time)' },
]

/**
 * Per-card point-in-time value for a chart grade, used to grey out grade
 * buttons that have no PriceCharting data yet and to render the "current
 * graded prices" summary strip above the chart.
 */
function pcPointValueForChartGrade(card: CardRow, key: ChartGradeKey): number | null {
  switch (key) {
    case 'raw':     return card.pc_price_raw ?? card.market_price ?? null
    case 'grade9':  return card.pc_price_grade9 ?? null
    case 'grade95': return card.pc_price_grade95 ?? null
    case 'psa10':   return card.pc_price_psa10 ?? null
    case 'bgs10':   return card.pc_price_bgs10 ?? null
  }
}

type SortKey =
  | 'market_price'
  | 'predicted_price'
  | 'pull_cost_score'
  | 'desirability_score'
  | 'reddit_buzz_score'
  | 'name'
  | 'set_id'
  | 'rarity'
  | 'card_type'
  | 'ebay_median'

const SORT_KEYS = new Set<SortKey>([
  'market_price',
  'predicted_price',
  'pull_cost_score',
  'desirability_score',
  'reddit_buzz_score',
  'name',
  'set_id',
  'rarity',
  'card_type',
  'ebay_median',
])

function coerceSort(s: string): SortKey {
  return SORT_KEYS.has(s as SortKey) ? (s as SortKey) : 'market_price'
}

/** True when model fair and listing differ by ~8×+ (either direction) — worth a second look, not an error flag. */
function isExtremeVsMarket(predicted: number | null, market: number | null): boolean {
  if (predicted == null || market == null || predicted <= 0 || market <= 0) return false
  const hi = Math.max(predicted, market)
  const lo = Math.min(predicted, market)
  return hi / lo >= 8
}

const CARDS_PAGE_SIZE = 80

export function Cards() {
  const location = useLocation()
  const [, setSearchParams] = useSearchParams()
  const { user, isPremium } = useAuth()

  const [qInput, setQInput] = useState(() => getInitialCardsFilters(location.search).q)
  const [qApplied, setQApplied] = useState(() => getInitialCardsFilters(location.search).q)
  const [setFilter, setSetFilter] = useState(() => getInitialCardsFilters(location.search).set_id)
  const [printFilter, setPrintFilter] = useState(() => getInitialCardsFilters(location.search).print)
  const [flagFilter, setFlagFilter] = useState(() => getInitialCardsFilters(location.search).flagFilter)
  const [sort, setSort] = useState<SortKey>(() => coerceSort(getInitialCardsFilters(location.search).sort))
  const [order, setOrder] = useState<'asc' | 'desc'>(() => getInitialCardsFilters(location.search).order)
  const [condition, setCondition] = useState<ConditionCode>(() => loadStoredCondition())
  const [showAdjusted, setShowAdjusted] = useState(() => loadShowAdjusted())

  const [columnVis, setColumnVis] = useState<Set<ColumnId>>(() => loadColumnVisibility())
  const [colMenuOpen, setColMenuOpen] = useState(false)
  const colMenuRef = useRef<HTMLDivElement>(null)

  const toggleColumn = (col: ColumnId) => {
    setColumnVis((prev) => {
      const next = new Set(prev)
      if (next.has(col)) next.delete(col)
      else next.add(col)
      saveColumnVisibility(next)
      return next
    })
  }

  useEffect(() => {
    if (!colMenuOpen) return
    const close = (e: MouseEvent) => {
      if (colMenuRef.current && !colMenuRef.current.contains(e.target as Node)) setColMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [colMenuOpen])

  const show = (col: ColumnId) => columnVis.has(col)

  const [open, setOpen] = useState(false)
  const [sel, setSel] = useState<CardRow | null>(null)
  const [hist, setHist] = useState<Hist[]>([])
  const [trendWindow, _setTrendWindow] = useState<TrendWindow>(() => loadTrendWindow())
  const setTrendWindow = (w: TrendWindow) => { _setTrendWindow(w); saveTrendWindow(w) }
  const [brushRange, setBrushRange] = useState<BrushRange | null>(null)
  const [insight, setInsight] = useState<CardInvestmentInsight | null>(null)
  const [buyLinks, setBuyLinks] = useState<{ tcgplayer: string; ebay: string; whatnot: string } | null>(null)
  const [selectedGrade, setSelectedGrade] = useState<ChartGradeKey>('raw')
  const [selectedSource, setSelectedSource] = useState<ChartSourceKey>('both')
  const [gradeMeta, setGradeMeta] = useState<{ pointInTime: boolean } | null>(null)

  useEffect(() => {
    setCondition(loadStoredCondition())
    setShowAdjusted(loadShowAdjusted())
  }, [])

  const metaQuery = useQuery({
    queryKey: ['api', 'meta', 'card-filters', setFilter || ''],
    queryFn: () =>
      api<CardFiltersMeta>(
        setFilter ? `/api/meta/card-filters?set_id=${encodeURIComponent(setFilter)}` : '/api/meta/card-filters',
      ),
    staleTime: 60_000,
  })
  const meta = metaQuery.data ?? null

  /** Scoped print list may exclude the current print when the set changes — avoid bad API queries. */
  const effectivePrintFilter = useMemo(() => {
    if (!printFilter) return ''
    if (!meta?.printBuckets) return printFilter
    return meta.printBuckets.includes(printFilter) ? printFilter : ''
  }, [printFilter, meta?.printBuckets])

  useEffect(() => {
    if (!meta?.printBuckets?.length) return
    if (printFilter && !meta.printBuckets.includes(printFilter)) {
      setPrintFilter('')
    }
  }, [meta?.printBuckets, printFilter])

  useEffect(() => {
    const n = getInitialCardsFilters(location.search)
    setQApplied(n.q)
    setQInput(n.q)
    setSetFilter(n.set_id)
    setPrintFilter(n.print)
    setSort(coerceSort(n.sort))
    setOrder(n.order)
    setFlagFilter(n.flagFilter)
  }, [location.search])

  useEffect(() => {
    const f: CardsFiltersPersisted = {
      q: qApplied,
      set_id: setFilter,
      print: effectivePrintFilter,
      sort,
      order,
      flagFilter,
    }
    saveCardsFilters(f)
    const next = cardsFiltersToSearchParams(f).toString()
    const cur = location.search.startsWith('?') ? location.search.slice(1) : location.search
    if (!searchParamsEqual(next, cur)) {
      setSearchParams(cardsFiltersToSearchParams(f), { replace: true })
    }
  }, [qApplied, setFilter, effectivePrintFilter, flagFilter, sort, order, location.search, setSearchParams])

  const cardsQuery = useInfiniteQuery({
    queryKey: ['api', 'cards', 'list', qApplied, setFilter, effectivePrintFilter, flagFilter, sort, order],
    queryFn: async ({ pageParam }): Promise<CardsListResponse> => {
      const params = new URLSearchParams()
      if (qApplied) params.set('q', qApplied)
      if (setFilter) params.set('set_id', setFilter)
      if (effectivePrintFilter) params.set('print', effectivePrintFilter)
      if (flagFilter) params.set('flag', flagFilter)
      params.set('sort', sort)
      params.set('order', order)
      params.set('limit', String(CARDS_PAGE_SIZE))
      params.set('offset', String(pageParam))
      return api<CardsListResponse>(`/api/cards?${params.toString()}`)
    },
    initialPageParam: 0,
    getNextPageParam: (last) =>
      last.offset + last.limit < last.total ? last.offset + last.limit : undefined,
    // 10s is short enough that an auth-state transition (login, upgrade)
    // is reflected quickly, long enough to survive normal pagination and
    // filter-toggling without refetch storms. Previously 45s held stale
    // free-tier results on screen after a session came back online.
    staleTime: 10_000,
  })

  const rows = useMemo(
    () => cardsQuery.data?.pages.flatMap((p) => p.items) ?? [],
    [cardsQuery.data?.pages],
  )
  const totalCount = cardsQuery.data?.pages[0]?.total ?? 0
  // If the server returned `tier_limited: true` but the client thinks the
  // user is premium/admin, we have a desync (usually: refresh token was
  // just rotated, the first request raced the new token). Surface a
  // banner and a one-shot refetch, instead of silently showing ~3 sets
  // worth of rows. This is the defense-in-depth layer behind the
  // SessionExpiredError hard-fail path in lib/api.ts.
  const tierLimited = cardsQuery.data?.pages[0]?.tier_limited === true
  // "tier desync" = server served free-tier data but client thinks user
  // is premium/admin. We only get here if the SessionExpiredError path
  // in lib/api.ts missed (e.g. the access token was valid at send time
  // but somehow the server treated the caller as anonymous, or a rare
  // cache-serving-stale-free-tier race). Force a one-shot refetch.
  const tierDesync = tierLimited && isPremium
  const lastDesyncRefetchRef = useRef(0)
  useEffect(() => {
    if (!tierDesync) return
    const now = Date.now()
    // Throttle the defensive refetch to at most once every 5s so a
    // persistent desync can't drive a refetch storm.
    if (now - lastDesyncRefetchRef.current < 5000) return
    lastDesyncRefetchRef.current = now
    void cardsQuery.refetch()
  }, [tierDesync, cardsQuery])

  const loading = cardsQuery.isPending
  const error =
    cardsQuery.error instanceof Error ? cardsQuery.error.message : cardsQuery.error ? String(cardsQuery.error) : null

  const applySearch = () => {
    setQApplied(qInput)
  }

  const onSortHeader = (key: SortKey) => {
    if (sort === key) setOrder((o) => (o === 'desc' ? 'asc' : 'desc'))
    else {
      setSort(key)
      setOrder('desc')
    }
  }

  const onConditionChange = (c: ConditionCode) => {
    setCondition(c)
    saveStoredCondition(c)
    if (c !== 'NM' && !showAdjusted) {
      setShowAdjusted(true)
      saveShowAdjusted(true)
    } else if (c === 'NM' && showAdjusted) {
      setShowAdjusted(false)
      saveShowAdjusted(false)
    }
  }

  const onShowAdjustedChange = (v: boolean) => {
    setShowAdjusted(v)
    saveShowAdjusted(v)
  }

  /**
   * Fetch history for the active grade from `/api/cards/:id/history?grade=...`
   * and marshal into the `Hist` shape the chart already consumes. For BGS 10
   * (point-in-time only) we still return one row so the stats panel renders,
   * but tag `gradeMeta.pointInTime` so the chart can render it as a reference
   * line rather than a misleading flat series.
   */
  const fetchGradeHistory = async (cardId: string, grade: ChartGradeKey, source: ChartSourceKey) => {
    try {
      const r = await api<{ grade: string; source: string; pointInTime: boolean; series: { timestamp: string; price: number }[] }>(
        `/api/cards/${cardId}/history?grade=${grade}&source=${source}`,
      )
      setGradeMeta({ pointInTime: !!r.pointInTime })
      setHist(r.series.map((p) => ({ timestamp: p.timestamp, tcgplayer_market: p.price })))
    } catch {
      setGradeMeta(null)
      setHist([])
    }
  }

  const openDetail = async (c: CardRow) => {
    setSel(c)
    setOpen(true)
    setInsight(null)
    setBrushRange(null)
    setSelectedGrade('raw')
    setSelectedSource('both')
    await fetchGradeHistory(c.id, 'raw', 'both')
    try {
      const i = await api<CardInvestmentInsight>(`/api/cards/${c.id}/investment`)
      setInsight(i)
    } catch {
      setInsight(null)
    }
    try {
      const links = await api<{ tcgplayer: string; ebay: string; whatnot: string }>(
        `/api/cards/${c.id}/buy-links`,
      )
      setBuyLinks(links)
    } catch {
      setBuyLinks(null)
    }
  }

  // Refetch when the user toggles grade OR source on an already-open card.
  useEffect(() => {
    if (!sel || !open) return
    void fetchGradeHistory(sel.id, selectedGrade, selectedSource)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGrade, selectedSource, sel?.id])

  const fullHistory = useMemo(() => buildFullHistory(hist), [hist])

  const chartData = useMemo(
    () => filterChartData(fullHistory, trendWindow),
    [fullHistory, trendWindow],
  )

  /**
   * Whether the *card* has any chartable data anywhere — current grade,
   * current source, or any of the point-in-time PC grade anchors. We use
   * this to decide whether to mount the whole price-history panel, so
   * flipping to an empty (grade, source) combination doesn't unmount the
   * buttons and strand the user. Previously we gated on `chartData.length
   * > 1` which made the panel disappear whenever the active filter had no
   * rows — e.g. clicking "PriceCharting" on a card that hasn't been
   * backfilled yet. The buttons need to survive empty selections so the
   * user can toggle back.
   */
  const cardHasAnyPriceData = useMemo(() => {
    if (!sel) return false
    if (chartData.length > 1) return true
    if (gradeMeta?.pointInTime) return true
    const anchors = [
      sel.pc_price_raw,
      sel.pc_price_grade7,
      sel.pc_price_grade8,
      sel.pc_price_grade9,
      sel.pc_price_grade95,
      sel.pc_price_psa10,
      sel.pc_price_bgs10,
      sel.market_price,
    ]
    return anchors.some((v) => v != null && v > 0)
  }, [sel, chartData.length, gradeMeta?.pointInTime])

  useEffect(() => {
    setBrushRange(null)
  }, [trendWindow, sel?.id, chartData.length])

  const brushStartIndex =
    brushRange?.startIndex != null
      ? Math.max(0, Math.min(chartData.length - 1, brushRange.startIndex))
      : 0
  const brushEndIndex =
    brushRange?.endIndex != null
      ? Math.max(0, Math.min(chartData.length - 1, brushRange.endIndex))
      : Math.max(0, chartData.length - 1)

  const brushMeta = useMemo(() => {
    if (!chartData.length) return null
    const start = chartData[brushStartIndex]
    const end = chartData[brushEndIndex]
    if (!start || !end) return null
    return {
      label: `${start.label} → ${end.label}`,
      points: Math.max(0, brushEndIndex - brushStartIndex + 1),
    }
  }, [chartData, brushStartIndex, brushEndIndex])

  const chartStats = useMemo(() => {
    if (chartData.length < 2) return null
    const first = chartData[0].p
    const last = chartData[chartData.length - 1].p
    const lo = Math.min(...chartData.map((d) => d.p))
    const hi = Math.max(...chartData.map((d) => d.p))
    const changePct = first > 0 ? ((last - first) / first) * 100 : 0
    return { first, last, lo, hi, changePct }
  }, [chartData])

  const condPct = Math.round((CONDITION_PCT[condition] ?? 1) * 100)

  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollMaxH, setScrollMaxH] = useState<number | undefined>(undefined)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => {
      const rect = el.getBoundingClientRect()
      const footerH = 40
      const available = window.innerHeight - rect.top - footerH - 4
      setScrollMaxH(Math.max(200, available))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  const setNameMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of meta?.sets ?? []) {
      if (s.name) m.set(s.id, s.name)
    }
    return m
  }, [meta?.sets])

  const tableMinWidth = useMemo(() => {
    let w = 0
    if (show('name')) w += 14
    if (show('ai')) w += 6.5
    if (show('set_id')) w += 10
    if (show('card_type')) w += 6
    if (show('rarity')) w += 9
    if (show('pull')) w += 3.5
    if (show('desire')) w += 4
    if (show('predicted')) { w += 6; if (showAdjusted) w += 7 }
    if (show('market')) { w += 5.5; if (showAdjusted) w += 7 }
    if (show('gap')) w += 6.5
    if (show('ebay')) w += 5
    if (show('flag')) w += 10
    if (show('future')) w += 9
    if (show('spark')) w += 10
    return `${w}rem`
  }, [columnVis, showAdjusted])

  const sentinelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && cardsQuery.hasNextPage && !cardsQuery.isFetchingNextPage) {
          void cardsQuery.fetchNextPage()
        }
      },
      { root: scrollRef.current, rootMargin: '200px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [cardsQuery.hasNextPage, cardsQuery.isFetchingNextPage, rows.length])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="flex items-start gap-1">
          <p className="shrink-0 text-xs text-muted-foreground sm:text-sm">
            Filter, sort, and inspect detailed card pricing signals. Open Help for formulas and metric definitions.
          </p>
          <HelpButton sectionId="cards-overview" className="mt-[-2px]" />
        </div>
        <UpgradeBanner />

        {tierDesync && user && (
          <div
            role="status"
            className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
          >
            <span className="font-medium">Reloading full catalog…</span>{' '}
            <span className="text-amber-200/80">
              The server briefly served a limited view. We're fetching the complete list for your
              account. If this keeps happening, sign out and back in.
            </span>
          </div>
        )}

        <div className="flex shrink-0 flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="q">Search</Label>
            <Input
              id="q"
              placeholder="Name…"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && applySearch()}
              className="w-48 min-w-[12rem]"
              aria-label="Search cards"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label id="set-label">Set</Label>
            <SetFilterDropdown
              sets={meta?.sets ?? []}
              value={setFilter}
              onChange={setSetFilter}
              disabled={loading}
              labelledBy="set-label"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="print">Print / rarity</Label>
            <select
              id="print"
              className="h-9 min-w-[10rem] rounded-md border border-input bg-background px-2 text-sm"
              value={printFilter}
              onChange={(e) => setPrintFilter(e.target.value)}
            >
              <option value="">All prints</option>
              {(meta?.printBuckets ?? []).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="flag-filter">Valuation</Label>
            <select
              id="flag-filter"
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={flagFilter}
              onChange={(e) => setFlagFilter(e.target.value)}
            >
              <option value="">All cards</option>
              <option value="UNDERVALUED">Undervalued</option>
              <option value="GROWTH">Growth buys</option>
              <option value="OVERVALUED">Overvalued</option>
              <option value="FAIRLY">Fairly valued</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="cond">Condition (view)</Label>
            <select
              id="cond"
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={condition}
              onChange={(e) => onConditionChange(e.target.value as ConditionCode)}
              title="Applies typical % of Near Mint for raw singles"
            >
              {(Object.keys(CONDITION_PCT) as ConditionCode[]).map((c) => (
                <option key={c} value={c} title={CONDITION_LABELS[c]}>
                  {c} ({Math.round(CONDITION_PCT[c] * 100)}% NM)
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2 pb-1">
            <input
              id="adj"
              type="checkbox"
              className="size-4 rounded border-input"
              checked={showAdjusted}
              onChange={(e) => onShowAdjustedChange(e.target.checked)}
            />
            <Label htmlFor="adj" className="text-sm font-normal">
              Show condition-adjusted market / predicted
            </Label>
          </div>
          <Button type="button" onClick={applySearch} disabled={loading}>
            Search
          </Button>
          <Button
            type="button"
            variant={flagFilter === 'UNDERVALUED' && sort === 'desirability_score' ? 'secondary' : 'outline'}
            size="sm"
            className="h-9"
            onClick={() => {
              setFlagFilter('UNDERVALUED')
              setSort('desirability_score' as SortKey)
              setOrder('desc')
              setQInput('')
              setQApplied('')
            }}
            title="Undervalued cards with highest desirability (factors in buzz + trends)"
          >
            Best deals
          </Button>
          <Button
            type="button"
            variant={flagFilter === 'UNDERVALUED' && sort === 'reddit_buzz_score' ? 'secondary' : 'outline'}
            size="sm"
            className="h-9"
            onClick={() => {
              setFlagFilter('UNDERVALUED')
              setSort('reddit_buzz_score' as SortKey)
              setOrder('desc')
              setQInput('')
              setQApplied('')
            }}
            title="Undervalued cards sorted by highest social momentum"
          >
            🔥 Hot deals
          </Button>
          {(flagFilter || qApplied || setFilter || printFilter) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-9 gap-1 text-xs text-muted-foreground"
              onClick={() => {
                setFlagFilter('')
                setQInput('')
                setQApplied('')
                setSetFilter('')
                setPrintFilter('')
                setSort('predicted_price' as SortKey)
                setOrder('desc')
              }}
              title="Reset all filters"
            >
              ✕ Clear filters
            </Button>
          )}

          <div ref={colMenuRef} className="relative pb-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 gap-1.5 text-xs"
              onClick={() => setColMenuOpen((o) => !o)}
            >
              {colMenuOpen ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              Columns
            </Button>
            {colMenuOpen && (
              <div className="absolute top-full left-0 z-50 mt-1 w-44 rounded-md border border-border bg-popover p-1 shadow-md">
                {ALL_COLUMNS.map((col) => (
                  <label
                    key={col}
                    className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-muted"
                  >
                    <input
                      type="checkbox"
                      className="size-3.5 rounded border-input"
                      checked={columnVis.has(col)}
                      onChange={() => toggleColumn(col)}
                    />
                    {COLUMN_LABELS[col]}
                  </label>
                ))}
                <div className="mt-1 flex gap-1 border-t border-border px-1 pt-1">
                  <button
                    type="button"
                    className="flex-1 rounded-sm px-2 py-1 text-xs hover:bg-muted"
                    onClick={() => {
                      const all = new Set<ColumnId>(ALL_COLUMNS)
                      setColumnVis(all)
                      saveColumnVisibility(all)
                    }}
                  >
                    Show all
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="shrink-0 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading && !rows.length ? (
          <div className="shrink-0 space-y-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded-md bg-muted/50" />
            ))}
          </div>
        ) : null}

        {!loading && !error && rows.length === 0 ? (
          <p className="shrink-0 text-sm text-muted-foreground">No cards match. Widen filters or run API ingest.</p>
        ) : null}

        {/* Fills remaining viewport height; both axes scroll here so the horizontal bar stays on-screen. */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            className="overflow-auto overscroll-contain rounded-t-lg border border-border"
            style={scrollMaxH != null ? { maxHeight: scrollMaxH } : undefined}
          >
            <div style={{ minWidth: tableMinWidth }}>
            <Table className="table-fixed w-full">
              <colgroup>
                {show('name') && <col style={{ width: '14rem' }} />}
                {show('ai') && <col style={{ width: '6.5rem' }} />}
                {show('set_id') && <col style={{ width: '10rem' }} />}
                {show('card_type') && <col style={{ width: '6rem' }} />}
                {show('rarity') && <col style={{ width: '9rem' }} />}
                {show('pull') && <col style={{ width: '3.5rem' }} />}
                {show('desire') && <col style={{ width: '4rem' }} />}
                {show('predicted') && <col style={{ width: '6rem' }} />}
                {show('predicted') && showAdjusted && <col style={{ width: '7rem' }} />}
                {show('market') && <col style={{ width: '5.5rem' }} />}
                {show('market') && showAdjusted && <col style={{ width: '7rem' }} />}
                {show('gap') && <col style={{ width: '6.5rem' }} />}
                {show('ebay') && <col style={{ width: '5rem' }} />}
                {show('flag') && <col style={{ width: '10rem' }} />}
                {show('future') && <col style={{ width: '9rem' }} />}
                {show('spark') && <col style={{ width: '10rem' }} />}
              </colgroup>
              <TableHeader className="sticky top-0 z-20 border-b border-border bg-background/95 shadow-sm backdrop-blur-sm supports-[backdrop-filter]:bg-background/80">
                <TableRow>
                  {show('name') && <SortHead label="Card" col="name" sort={sort} order={order} onSort={onSortHeader} />}
                  {show('ai') && (
                    <TableHead
                      className="truncate"
                      title="Composite score [0-1]. BUY >= 0.72, WATCH >= 0.50, PASS otherwise."
                    >
                      AI score
                    </TableHead>
                  )}
                  {show('set_id') && <SortHead label="Set name" col="set_id" sort={sort} order={order} onSort={onSortHeader} />}
                  {show('card_type') && <SortHead label="Print" col="card_type" sort={sort} order={order} onSort={onSortHeader} />}
                  {show('rarity') && <SortHead label="Rarity" col="rarity" sort={sort} order={order} onSort={onSortHeader} />}
                  {show('pull') && <SortHead label="Pull" col="pull_cost_score" sort={sort} order={order} onSort={onSortHeader} />}
                  {show('desire') && <SortHead label="Desire" col="desirability_score" sort={sort} order={order} onSort={onSortHeader} />}
                  {show('predicted') && (
                    <SortHead
                      label="Model fair"
                      col="predicted_price"
                      sort={sort}
                      order={order}
                      onSort={onSortHeader}
                      title="Internal heuristic, blended toward same set + rarity tier median. Not a price guide."
                      extra={<HelpButton sectionId="cards-model-fair" />}
                    />
                  )}
                  {show('predicted') && showAdjusted && (
                    <TableHead className="truncate text-xs" title={`Adj fair × ${condPct}% (${condition})`}>
                      Fair ({condition})
                    </TableHead>
                  )}
                  {show('market') && (
                    <SortHead
                      label="Market"
                      col="market_price"
                      sort={sort}
                      order={order}
                      onSort={onSortHeader}
                      title="Latest TCGPlayer market snapshot."
                    />
                  )}
                  {show('market') && showAdjusted && (
                    <TableHead className="truncate text-xs" title={`Adj mkt × ${condPct}% (${condition})`}>
                      Mkt ({condition})
                    </TableHead>
                  )}
                  {show('gap') && (
                    <TableHead
                      className="cursor-help truncate"
                      title="Market price minus model fair. Negative = deal vs the model."
                    >
                      vs model ($)
                    </TableHead>
                  )}
                  {show('ebay') && <SortHead label="eBay" col="ebay_median" sort={sort} order={order} onSort={onSortHeader} />}
                  {show('flag') && <TableHead className="truncate">Valuation</TableHead>}
                  {show('future') && (
                    <TableHead
                      className="truncate"
                      title="Projected 12-month value based on character popularity, rarity, trends, and price momentum"
                    >
                      12m forecast
                    </TableHead>
                  )}
                  {show('spark') && (
                    <TableHead className="truncate">
                      <span className="inline-flex items-center gap-1">
                        30d trend
                        <HelpButton sectionId="cards-30d-trend" />
                      </span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {!loading &&
                  rows.map((c) => {
                    const adjM = adjustPrice(c.market_price, condition)
                    const adjP = adjustPrice(c.predicted_price, condition)
                    const gb = gapDollarBadge(c.predicted_price, c.market_price)
                    return (
                      <TableRow key={c.id} className="cursor-pointer" onClick={() => openDetail(c)}>
                        {show('name') && <TableCell className="truncate font-medium" title={c.name}>{c.name}</TableCell>}
                        {show('ai') && (
                          <TableCell className="overflow-hidden">
                            <AiScoreBadge score={c.ai_score ?? 0} decision={c.ai_decision ?? 'PASS'} />
                          </TableCell>
                        )}
                        {show('set_id') && (
                          <TableCell className="truncate" title={`${c.set_id} — ${setNameMap.get(c.set_id ?? '') ?? c.set_id}`}>
                            <span className="text-foreground">{setNameMap.get(c.set_id ?? '') ?? c.set_id}</span>
                          </TableCell>
                        )}
                        {show('card_type') && <TableCell className="truncate text-muted-foreground">{c.card_type ?? '—'}</TableCell>}
                        {show('rarity') && <TableCell className="truncate text-xs text-muted-foreground" title={c.rarity ?? ''}>{c.rarity}</TableCell>}
                        {show('pull') && <TableCell>{c.pull_cost_score?.toFixed(1) ?? '—'}</TableCell>}
                        {show('desire') && <TableCell>{c.desirability_score?.toFixed(1) ?? '—'}</TableCell>}
                        {show('predicted') && (
                          <TableCell className="overflow-hidden whitespace-nowrap">
                            <span className="tabular-nums">
                              {c.predicted_price != null ? `$${c.predicted_price.toFixed(2)}` : '—'}
                            </span>
                            {isExtremeVsMarket(c.predicted_price, c.market_price) && (
                              <ExtremeGapWarning predicted={c.predicted_price} market={c.market_price} />
                            )}
                          </TableCell>
                        )}
                        {show('predicted') && showAdjusted && (
                          <TableCell className="overflow-hidden text-xs tabular-nums">{adjP != null ? `$${adjP.toFixed(2)}` : '—'}</TableCell>
                        )}
                        {show('market') && (
                          <TableCell className="overflow-hidden tabular-nums">{c.market_price != null ? `$${c.market_price.toFixed(2)}` : '—'}</TableCell>
                        )}
                        {show('market') && showAdjusted && (
                          <TableCell className="overflow-hidden text-xs tabular-nums">{adjM != null ? `$${adjM.toFixed(2)}` : '—'}</TableCell>
                        )}
                        {show('gap') && (
                          <TableCell className="whitespace-nowrap">
                            <span className={cn('inline-block rounded-md border px-1.5 py-0.5 text-xs font-medium tabular-nums', gb.className)}>
                              {gb.label}
                            </span>
                          </TableCell>
                        )}
                        {show('ebay') && (
                          <TableCell>{c.ebay_median != null ? `$${c.ebay_median.toFixed(2)}` : '—'}</TableCell>
                        )}
                        {show('flag') && (
                          <TableCell>
                            <ValuationBadge flag={c.valuation_flag} />
                          </TableCell>
                        )}
                        {show('future') && (
                          <TableCell className="overflow-hidden tabular-nums">
                            {c.future_value_12m != null && c.future_value_12m > 0 ? (
                              <div className="flex items-baseline gap-1 truncate">
                                <span className="shrink-0 text-xs font-medium">${c.future_value_12m.toFixed(2)}</span>
                                {c.annual_growth_rate != null && (
                                  <span className={cn(
                                    'shrink-0 text-[0.65rem]',
                                    c.annual_growth_rate >= 0.10 ? 'text-emerald-600 dark:text-emerald-400'
                                      : c.annual_growth_rate >= 0.0 ? 'text-amber-600 dark:text-amber-400'
                                        : 'text-red-500',
                                  )}>
                                    {c.annual_growth_rate >= 0 ? '▲' : '▼'}
                                    {Math.abs(c.annual_growth_rate * 100).toFixed(0)}%
                                  </span>
                                )}
                              </div>
                            ) : '—'}
                          </TableCell>
                        )}
                        {show('spark') && (
                          <TableCell className="w-40">
                            <MiniSpark data={c.spark_30d ?? []} />
                          </TableCell>
                        )}
                      </TableRow>
                    )
                  })}
              </TableBody>
            </Table>
            </div>
            {/* Sentinel for infinite scroll — triggers fetchNextPage when visible */}
            <div ref={sentinelRef} className="h-1 shrink-0" style={{ minWidth: tableMinWidth }} />
            {cardsQuery.isFetchingNextPage && (
              <div className="flex items-center justify-center gap-2 py-3 text-sm text-muted-foreground">
                <span className="inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Loading more…
              </div>
            )}
          </div>
          {!loading && !error && totalCount > 0 && (
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-b-lg border border-t-0 border-border bg-muted/10 px-3 py-2.5 text-sm">
              <span className="text-muted-foreground">
                Showing <span className="font-medium text-foreground">{rows.length}</span> of{' '}
                <span className="font-medium text-foreground">{totalCount}</span> cards
              </span>
              {cardsQuery.hasNextPage && !cardsQuery.isFetchingNextPage && (
                <span className="text-xs text-muted-foreground">Scroll for more</span>
              )}
            </div>
          )}
        </div>
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <div className="flex items-center gap-1">
              <SheetTitle>{sel?.name}</SheetTitle>
              <HelpButton sectionId="cards-detail-sheet" />
            </div>
          </SheetHeader>
          {sel?.image_url && (
            <img src={sel.image_url} alt="" className="mx-auto mt-4 max-h-80 rounded-lg border border-border" />
          )}
          <div className="mt-4 space-y-2 text-sm">
            <Explain label="Pull cost score" value={sel?.pull_cost_score} />
            <Explain label="Desirability" value={sel?.desirability_score} />
            <Explain
              label="Model fair (NM heuristic)"
              value={sel?.predicted_price}
              prefix="$"
              hint="Shrunk toward typical listings in this set + rarity tier. Not a guaranteed comp."
            />
            <Explain
              label={`Predicted × ${condition} (${condPct}% NM)`}
              value={adjustPrice(sel?.predicted_price ?? null, condition)}
              prefix="$"
            />
            <Explain label="Market (raw/ungraded)" value={sel?.market_price} prefix="$" />
            <Explain
              label={`Market × ${condition}`}
              value={adjustPrice(sel?.market_price ?? null, condition)}
              prefix="$"
            />
            {sel && hasGradedPrices(sel) && <GradedPricesPanel card={sel} />}
            {sel &&
              gapDollars(sel.predicted_price, sel.market_price) != null &&
              (() => {
                const gb = gapDollarBadge(sel.predicted_price, sel.market_price)
                return (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">vs model (market − fair)</span>
                    <span className={cn('rounded-md border px-2 py-0.5 text-xs font-semibold tabular-nums', gb.className)}>
                      {gb.label}
                    </span>
                  </div>
                )
              })()}
            {sel?.future_value_12m != null && sel.future_value_12m > 0 && (
              <div className="mt-2 rounded-md border border-border/60 bg-muted/15 p-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">12-month forecast</span>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-sm font-semibold tabular-nums">${sel.future_value_12m.toFixed(2)}</span>
                    {sel.annual_growth_rate != null && (
                      <span className={cn(
                        'text-xs font-medium',
                        sel.annual_growth_rate >= 0.10 ? 'text-emerald-600 dark:text-emerald-400'
                          : sel.annual_growth_rate >= 0 ? 'text-amber-600 dark:text-amber-400'
                            : 'text-red-500',
                      )}>
                        {sel.annual_growth_rate >= 0 ? '+' : ''}
                        {(sel.annual_growth_rate * 100).toFixed(0)}%/yr
                      </span>
                    )}
                  </div>
                </div>
                {sel.market_price != null && sel.market_price > 0 && sel.future_value_12m > sel.market_price && (
                  <p className="mt-1 text-[0.65rem] text-emerald-700 dark:text-emerald-400">
                    Potential upside: +${(sel.future_value_12m - sel.market_price).toFixed(2)} ({((sel.future_value_12m / sel.market_price - 1) * 100).toFixed(0)}% from current market)
                  </p>
                )}
              </div>
            )}
            {sel?.explain_json && <ModelExplainPanel json={sel.explain_json} />}
            {insight && <InvestmentInsightPanel insight={insight} />}
          </div>
          {cardHasAnyPriceData && (
            <div className="mt-4 rounded-lg border border-border/70 bg-muted/15 p-3">
              <div className="mb-2 flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <p className="text-xs font-medium text-foreground">
                      Price history — {CHART_GRADE_OPTIONS.find((g) => g.key === selectedGrade)?.long ?? 'Raw'}
                    </p>
                    <span
                      className="cursor-help text-[0.65rem] text-muted-foreground"
                      title={
                        'Data sources:\n' +
                        '• TCGPlayer — live market ticks from PokemonTCG.io feed, outlier-gated on ingest.\n' +
                        '• PriceCharting point-in-time prices (raw / Grade 7-9.5 / PSA 10 / BGS 10) — PriceCharting API, authenticated with your API key.\n' +
                        '• PriceCharting historical series (all grades except BGS 10) — PriceCharting public product pages (VGPC.chart_data). Same data PC displays on their own charts; no auth required.\n' +
                        'Toggle "All" blends both with PriceCharting preferred on overlap. BGS 10 is a single point-in-time reference only.'
                      }
                    >
                      ⓘ
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {(
                      [
                        ['1m', '1M'],
                        ['3m', '3M'],
                        ['6m', '6M'],
                        ['1y', '1Y'],
                        ['all', 'ALL'],
                      ] as const
                    ).map(([k, label]) => (
                      <Button
                        key={k}
                        type="button"
                        size="xs"
                        variant={trendWindow === k ? 'secondary' : 'outline'}
                        onClick={() => setTrendWindow(k)}
                        disabled={gradeMeta?.pointInTime}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[0.65rem] uppercase tracking-wider text-muted-foreground">Grade</span>
                  <div className="flex flex-wrap gap-1">
                    {CHART_GRADE_OPTIONS.map((g) => {
                      const pointValue = sel ? pcPointValueForChartGrade(sel, g.key) : null
                      const hasData =
                        g.key === 'raw' ||
                        g.key === 'bgs10' ||
                        (pointValue != null && pointValue > 0)
                      return (
                        <Button
                          key={g.key}
                          type="button"
                          size="xs"
                          variant={selectedGrade === g.key ? 'secondary' : 'outline'}
                          onClick={() => setSelectedGrade(g.key)}
                          disabled={!hasData}
                          title={hasData ? undefined : 'No PriceCharting data yet for this grade'}
                          aria-label={`Show ${g.long} history`}
                        >
                          {g.label}
                        </Button>
                      )
                    })}
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[0.65rem] uppercase tracking-wider text-muted-foreground">Source</span>
                  <div className="flex flex-wrap gap-1">
                    {CHART_SOURCE_OPTIONS.map((s) => {
                      // Graded series are PC-only (TCGPlayer doesn't publish
                      // graded data); BGS 10 is PC-only by construction
                      // (point-in-time reference). In both cases selecting
                      // TCGPlayer would just return empty — disable to keep
                      // the button meaningful and avoid a confusing empty
                      // state the user can't escape from.
                      const disabled =
                        s.key === 'tcgplayer' &&
                        (selectedGrade !== 'raw' || !!gradeMeta?.pointInTime)
                      return (
                        <Button
                          key={s.key}
                          type="button"
                          size="xs"
                          variant={selectedSource === s.key ? 'secondary' : 'outline'}
                          onClick={() => setSelectedSource(s.key)}
                          disabled={disabled}
                          title={
                            disabled
                              ? 'TCGPlayer does not publish graded series — select PriceCharting or All'
                              : s.long
                          }
                          aria-label={`Filter chart to ${s.long}`}
                        >
                          {s.label}
                        </Button>
                      )
                    })}
                  </div>
                </div>
              </div>

              {sel && CHART_GRADE_OPTIONS.some((g) => {
                const v = pcPointValueForChartGrade(sel, g.key)
                return g.key !== 'raw' && v != null && v > 0
              }) && (
                <div className="mb-2 rounded-md border border-border/70 bg-background/70 px-2 py-1.5">
                  <p className="mb-1 text-[0.65rem] uppercase tracking-wider text-muted-foreground">
                    Current graded prices · PriceCharting API
                  </p>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[0.7rem] sm:grid-cols-5">
                    {CHART_GRADE_OPTIONS.map((g) => {
                      const v = pcPointValueForChartGrade(sel, g.key)
                      return (
                        <div key={g.key} className="flex items-baseline justify-between gap-1">
                          <span className="text-muted-foreground">{g.label}</span>
                          <span className="tabular-nums font-medium">
                            {v != null && v > 0 ? `$${v.toFixed(2)}` : '—'}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {chartStats && (
                <div className="mb-2 grid grid-cols-2 gap-2 text-[0.7rem] sm:grid-cols-4">
                  <div className="rounded-md border border-border/70 bg-background/70 px-2 py-1.5">
                    <p className="text-muted-foreground">Range</p>
                    <p className="tabular-nums">${chartStats.lo.toFixed(2)} - ${chartStats.hi.toFixed(2)}</p>
                  </div>
                  <div className="rounded-md border border-border/70 bg-background/70 px-2 py-1.5">
                    <p className="text-muted-foreground">Start</p>
                    <p className="tabular-nums">${chartStats.first.toFixed(2)}</p>
                  </div>
                  <div className="rounded-md border border-border/70 bg-background/70 px-2 py-1.5">
                    <p className="text-muted-foreground">Latest</p>
                    <p className="tabular-nums">${chartStats.last.toFixed(2)}</p>
                  </div>
                  <div className="rounded-md border border-border/70 bg-background/70 px-2 py-1.5">
                    <p className="text-muted-foreground">Change</p>
                    <p
                      className={cn(
                        'tabular-nums font-medium',
                        chartStats.changePct >= 2
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : chartStats.changePct <= -2
                            ? 'text-red-500'
                            : 'text-muted-foreground',
                      )}
                    >
                      {chartStats.changePct >= 0 ? '+' : ''}
                      {chartStats.changePct.toFixed(1)}%
                    </p>
                  </div>
                </div>
              )}

              <div className="cards-history-chart h-56 text-primary">
                {chartData.length >= 2 && chartData[0].ts !== chartData[chartData.length - 1].ts ? (
                <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
                  <AreaChart data={chartData} margin={{ top: 8, right: 16, left: 2, bottom: 30 }}>
                    <defs>
                      <linearGradient id="cards-history-fill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="currentColor" stopOpacity={0.3} />
                        <stop offset="100%" stopColor="currentColor" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 5" opacity={0.45} />
                    <XAxis
                      dataKey="ts"
                      type="number"
                      domain={['dataMin', 'dataMax']}
                      tick={{ fontSize: 11, fill: 'hsl(var(--foreground))' }}
                      tickFormatter={(v: number) => {
                        const d = new Date(v)
                        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                      }}
                      minTickGap={32}
                      allowDataOverflow={false}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: 'hsl(var(--foreground))' }}
                      tickFormatter={(v) => `$${Number(v).toFixed(0)}`}
                      width={42}
                      domain={['auto', 'auto']}
                    />
                    <RTooltip
                      formatter={(value: unknown) => [`$${Number(value).toFixed(2)}`, 'Price']}
                      labelFormatter={(v) => {
                        const n = typeof v === 'number' ? v : Number(v)
                        return Number.isFinite(n) ? new Date(n).toLocaleDateString() : ''
                      }}
                      contentStyle={{
                        background: 'hsl(var(--popover))',
                        color: 'hsl(var(--popover-foreground))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: 10,
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="p"
                      stroke="currentColor"
                      fill="url(#cards-history-fill)"
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, strokeWidth: 2, stroke: 'hsl(var(--background))' }}
                    />
                    {chartData.length > 24 && (
                      <Brush
                        dataKey="brushLabel"
                        height={28}
                        stroke="hsl(var(--primary))"
                        fill="hsl(var(--background))"
                        travellerWidth={12}
                        startIndex={brushStartIndex}
                        endIndex={brushEndIndex}
                        tickFormatter={(v) => String(v)}
                        onChange={(next) => {
                          if (next?.startIndex == null || next?.endIndex == null) return
                          setBrushRange({
                            startIndex: Number(next.startIndex),
                            endIndex: Number(next.endIndex),
                          })
                        }}
                      />
                    )}
                  </AreaChart>
                </ResponsiveContainer>
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center text-xs text-muted-foreground">
                    {selectedSource === 'pricecharting' && selectedGrade === 'raw' ? (
                      <>
                        <span>No PriceCharting history for this card yet.</span>
                        <span className="text-[0.65rem]">
                          Backfill hasn't run for this card — try "All" or "TCGPlayer", or contact an admin to kick off a backfill.
                        </span>
                      </>
                    ) : selectedSource === 'tcgplayer' && selectedGrade !== 'raw' ? (
                      <span>TCGPlayer does not publish graded-card series — switch source to "PriceCharting" or "All".</span>
                    ) : gradeMeta?.pointInTime ? (
                      <span>This grade is a point-in-time reference only (no historical series available).</span>
                    ) : (
                      <span>Not enough data to display chart for this selection.</span>
                    )}
                  </div>
                )}
              </div>
              {chartData.length > 24 && brushMeta && (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/35 bg-gradient-to-r from-primary/10 via-background to-primary/5 px-2.5 py-1.5 text-xs shadow-sm">
                  <p className="font-semibold tracking-wide text-foreground">Window: {brushMeta.label}</p>
                  <p className="font-medium text-primary">{brushMeta.points} points</p>
                </div>
              )}
            </div>
          )}
          {buyLinks && (
            <div className="mt-4 flex flex-wrap gap-2">
              <a
                className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}
                href={buyLinks.tcgplayer}
                target="_blank"
                rel="noreferrer"
              >
                TCGPlayer
              </a>
              <a
                className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}
                href={buyLinks.ebay}
                target="_blank"
                rel="noreferrer"
              >
                eBay sold
              </a>
              <a
                className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}
                href={buyLinks.whatnot}
                target="_blank"
                rel="noreferrer"
              >
                Whatnot
              </a>
            </div>
          )}
          <PsaRoi
            cardName={sel?.name ?? ''}
            rawPrice={adjustPrice(sel?.market_price ?? null, condition) ?? sel?.market_price ?? 0}
          />
        </SheetContent>
      </Sheet>
    </div>
  )
}

function SetFilterDropdown({
  sets,
  value,
  onChange,
  disabled,
  labelledBy,
}: {
  sets: SetMeta[]
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  labelledBy?: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const selected = sets.find((s) => s.id === value)
  const summary = !value ? 'All sets' : `${value} — ${selected?.name ?? value}`

  return (
    <div ref={rootRef} className="relative min-w-[12rem] max-w-[min(100vw-2rem,18rem)]">
      <Button
        type="button"
        variant="outline"
        id="set-picker-trigger"
        className="h-9 w-full justify-between gap-2 px-2 font-normal"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-labelledby={labelledBy ? `${labelledBy} set-picker-trigger` : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="truncate text-left">{summary}</span>
        <ChevronDown className={cn('size-4 shrink-0 opacity-60 transition-transform', open && 'rotate-180')} />
      </Button>
      {open && (
        <div
          className="absolute top-full right-0 z-50 mt-1 max-h-72 w-[min(100vw-2rem,22rem)] overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
          role="listbox"
          aria-labelledby={labelledBy}
        >
          <button
            type="button"
            role="option"
            aria-selected={value === ''}
            className={cn(
              'w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted',
              value === '' && 'bg-muted font-medium',
            )}
            onClick={() => {
              onChange('')
              setOpen(false)
            }}
          >
            All sets
          </button>
          {sets.map((s) => (
            <div key={s.id} className="w-full">
              <Tooltip>
                <TooltipTrigger className="block w-full border-0 bg-transparent p-0 text-left">
                  <button
                    type="button"
                    role="option"
                    aria-selected={value === s.id}
                    title={setHoverTitle(s)}
                    className={cn(
                      'w-full truncate rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted',
                      value === s.id && 'bg-muted font-medium',
                    )}
                    onClick={() => {
                      onChange(s.id)
                      setOpen(false)
                    }}
                  >
                    <span className="text-muted-foreground">{s.id}</span>
                    <span> — {s.name ?? s.id}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" align="start" className="max-w-xs">
                  <SetMetaTooltipBody s={s} />
                </TooltipContent>
              </Tooltip>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SortHead({
  label,
  col,
  sort,
  order,
  onSort,
  title,
  extra,
}: {
  label: string
  col: SortKey
  sort: SortKey
  order: 'asc' | 'desc'
  onSort: (k: SortKey) => void
  /** Native tooltip — short hint for column meaning */
  title?: string
  extra?: React.ReactNode
}) {
  const active = sort === col
  return (
    <TableHead
      title={title}
      className="cursor-pointer select-none truncate hover:bg-muted/50"
      onClick={(e) => {
        e.stopPropagation()
        onSort(col)
      }}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (order === 'desc' ? ' \u2193' : ' \u2191') : ''}
        {extra}
      </span>
    </TableHead>
  )
}

function ExtremeGapWarning({ predicted, market }: { predicted: number | null; market: number | null }) {
  const [show, setShow] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [panelPos, setPanelPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 })

  useLayoutEffect(() => {
    if (!show || !btnRef.current) return
    const btn = btnRef.current.getBoundingClientRect()
    const margin = 8
    const estH = 280
    const estW = 288
    const spaceAbove = btn.top
    const placeAbove = spaceAbove >= estH + margin
    let left = btn.left + btn.width / 2 - estW / 2
    left = Math.max(margin, Math.min(left, window.innerWidth - estW - margin))
    const top = placeAbove ? btn.top - margin - estH : btn.bottom + margin
    setPanelPos({ left, top })
  }, [show])

  useEffect(() => {
    if (!show) return
    const close = (e: MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || panelRef.current?.contains(t)) return
      setShow(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [show])

  const gb = gapDollarBadge(predicted, market)

  const panelEl = (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      className="fixed z-[300] w-[min(18rem,calc(100vw-1.5rem))] rounded-xl border border-amber-500/35 bg-popover p-4 text-sm text-popover-foreground shadow-2xl ring-1 ring-black/10 dark:ring-white/10"
      style={{ left: panelPos.left, top: panelPos.top }}
      onClick={(e) => e.stopPropagation()}
    >
      <p className="font-semibold text-foreground">Large gap vs market</p>
      <div className="mt-2 flex flex-wrap items-center gap-3 rounded-md bg-muted/40 px-3 py-2">
        <div className="text-center">
          <span className="block text-xs text-muted-foreground">Model fair</span>
          <span className="text-base font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
            ${predicted?.toFixed(2) ?? '—'}
          </span>
        </div>
        <span className="text-lg text-muted-foreground">→</span>
        <div className="text-center">
          <span className="block text-xs text-muted-foreground">Market</span>
          <span className="text-base font-semibold tabular-nums text-sky-600 dark:text-sky-400">
            ${market?.toFixed(2) ?? '—'}
          </span>
        </div>
        <span
          className={cn('ml-auto rounded-md border px-2 py-0.5 text-xs font-semibold tabular-nums', gb.className)}
          title="Dollar gap vs model"
        >
          {gb.label}
        </span>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        The model uses pull + desirability scores blended toward same-set peers. Large gaps often mean the
        card trades on hype or scarcity the model doesn&apos;t fully capture. Open the row for details.
      </p>
      <button
        type="button"
        className="mt-3 w-full rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/80"
        onClick={(e) => {
          e.stopPropagation()
          setShow(false)
        }}
      >
        Got it
      </button>
    </div>
  )

  return (
    <span className="inline-flex">
      <button
        ref={btnRef}
        type="button"
        className="ml-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:border-amber-400/50 dark:text-amber-300"
        aria-label="Large gap between model and market"
        aria-expanded={show}
        onClick={(e) => {
          e.stopPropagation()
          setShow((o) => !o)
        }}
      >
        <AlertTriangle className="size-3.5" />
      </button>
      {show && typeof document !== 'undefined' ? createPortal(panelEl, document.body) : null}
    </span>
  )
}

function ModelExplainPanel({ json }: { json: string }) {
  let o: Record<string, unknown>
  try {
    o = JSON.parse(json) as Record<string, unknown>
  } catch {
    return <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-2 text-xs">{json}</pre>
  }

  const pull = typeof o.pullCostScore === 'number' ? o.pullCostScore : null
  const des = typeof o.desirabilityScore === 'number' ? o.desirabilityScore : null
  const base = typeof o.basePrice === 'number' ? o.basePrice : null
  const raw = typeof o.rawPredicted === 'number' ? o.rawPredicted : null
  const peer = typeof o.peerTierMedian === 'number' ? o.peerTierMedian : null
  const mkt = typeof o.market === 'number' ? o.market : null
  const pred = typeof o.predicted === 'number' ? o.predicted : null
  const mults = o.multipliers as { pull?: number; desirability?: number } | undefined

  const pullMult = (pull != null && mults?.pull) ? Math.pow(mults.pull, pull) : null
  const desMult = (des != null && mults?.desirability) ? Math.pow(mults.desirability, des) : null

  const mktTrust = mkt != null && mkt > 0
    ? Math.min(0.85, 0.50 + Math.log10(Math.max(mkt, 1)) * 0.12)
    : null
  const mktTrustPct = mktTrust != null ? Math.round(mktTrust * 100) : null

  return (
    <div className="mt-3 space-y-3 rounded-md border border-border bg-muted/20 p-3 text-xs">
      <p className="font-medium text-foreground">How fair value is calculated</p>

      <div className="space-y-1.5">
        {pull != null && (
          <div className="flex items-center gap-2">
            <span className="w-20 text-muted-foreground">Pull cost</span>
            <div className="h-1.5 flex-1 rounded-full bg-muted">
              <div className="h-1.5 rounded-full bg-sky-500" style={{ width: `${(pull / 10) * 100}%` }} />
            </div>
            <span className="w-10 text-right tabular-nums text-foreground">{pull.toFixed(1)}</span>
          </div>
        )}
        {des != null && (
          <div className="flex items-center gap-2">
            <span className="w-20 text-muted-foreground">Desirability</span>
            <div className="h-1.5 flex-1 rounded-full bg-muted">
              <div className="h-1.5 rounded-full bg-violet-500" style={{ width: `${(des / 10) * 100}%` }} />
            </div>
            <span className="w-10 text-right tabular-nums text-foreground">{des.toFixed(1)}</span>
          </div>
        )}
      </div>

      <div className="space-y-2 rounded-md border border-border/60 bg-background/50 p-2.5">
        <p className="text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">Step 1 — Raw model estimate</p>
        <div className="flex flex-wrap items-baseline gap-x-1 text-sm leading-relaxed">
          {base != null && (
            <span className="text-muted-foreground">
              Base <strong className="text-foreground">${base.toFixed(2)}</strong>
            </span>
          )}
          {pullMult != null && (
            <span className="text-muted-foreground">
              × pull <strong className="text-foreground">{pullMult.toFixed(1)}×</strong>
            </span>
          )}
          {desMult != null && (
            <span className="text-muted-foreground">
              × desire <strong className="text-foreground">{desMult.toFixed(1)}×</strong>
            </span>
          )}
          {raw != null && (
            <span className="text-muted-foreground">
              = <strong className="text-foreground">${raw.toFixed(2)}</strong>
            </span>
          )}
        </div>
        <p className="text-[0.6rem] text-muted-foreground">
          The raw estimate uses pull cost and desirability scores as exponential multipliers on a calibrated base price.
          This captures card mechanics but not collector premiums, so it works best for cards under ~$50.
        </p>
      </div>

      <div className="space-y-2 rounded-md border border-border/60 bg-background/50 p-2.5">
        <p className="text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">Step 2 — Adaptive market anchoring</p>
        <div className="space-y-1 text-sm leading-relaxed text-muted-foreground">
          {mkt != null && mktTrustPct != null ? (
            <>
              <p>
                Market price: <strong className="text-foreground">${mkt.toFixed(2)}</strong>
                {peer != null && <> · Peer median: <strong className="text-foreground">${peer.toFixed(2)}</strong></>}
              </p>
              <div className="flex items-center gap-2 pt-1">
                <span className="w-24 shrink-0 text-[0.6rem]">Market trust</span>
                <div className="h-2 flex-1 rounded-full bg-muted">
                  <div
                    className="h-2 rounded-full bg-amber-500"
                    style={{ width: `${mktTrustPct}%` }}
                  />
                </div>
                <span className="w-10 text-right tabular-nums text-foreground text-[0.65rem]">{mktTrustPct}%</span>
              </div>
              <p className="text-[0.6rem]">
                {mktTrustPct >= 75
                  ? 'This is an expensive card — the model heavily trusts market price because the raw formula cannot independently capture collector premiums at this level.'
                  : mktTrustPct >= 60
                    ? 'Moderate-priced card — the model blends its estimate with market price, giving market the larger weight.'
                    : 'Lower-priced card — the model relies more on its own pull/desire estimate, using market as a cross-check.'}
              </p>
            </>
          ) : peer != null ? (
            <p>
              No market price available. Blended with peer median <strong className="text-foreground">${peer.toFixed(2)}</strong> (70% peer, 30% model).
            </p>
          ) : (
            <p>No market or peer data available. Using raw model estimate only.</p>
          )}
        </div>
        {pred != null && (
          <p className="pt-1 text-sm font-medium">
            Fair value: <strong className="text-foreground">${pred.toFixed(2)}</strong>
          </p>
        )}
        <p className="text-[0.6rem] text-muted-foreground">
          Capped at 1.8× market and 3.5× peer median to prevent overestimation.
        </p>
      </div>

      {(() => {
        const fv = typeof o.futureValue12m === 'number' ? o.futureValue12m : null
        const gr = typeof o.annualGrowthRate === 'number' ? o.annualGrowthRate : null
        if (fv == null || fv <= 0) return null
        const isGrowth = gr != null && gr >= 0.10 && fv > (mkt ?? 0) * 1.05
        return (
          <div className="space-y-2 rounded-md border border-border/60 bg-background/50 p-2.5">
            <p className="text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">Step 3 — 12-month forecast</p>
            <div className="flex items-baseline gap-2 text-sm">
              <span className="text-muted-foreground">Projected value:</span>
              <strong className={cn('text-foreground', isGrowth && 'text-emerald-600 dark:text-emerald-400')}>
                ${fv.toFixed(2)}
              </strong>
              {gr != null && (
                <span className={cn(
                  'text-xs',
                  gr >= 0.10 ? 'text-emerald-600 dark:text-emerald-400'
                    : gr >= 0 ? 'text-amber-600 dark:text-amber-400'
                      : 'text-red-500',
                )}>
                  ({gr >= 0 ? '+' : ''}{(gr * 100).toFixed(0)}%/yr)
                </span>
              )}
            </div>
            {gr != null && (
              <div className="flex items-center gap-2 pt-0.5">
                <span className="w-24 shrink-0 text-[0.6rem] text-muted-foreground">Growth rate</span>
                <div className="h-2 flex-1 rounded-full bg-muted">
                  <div
                    className={cn('h-2 rounded-full', gr >= 0.10 ? 'bg-emerald-500' : gr >= 0 ? 'bg-amber-500' : 'bg-red-500')}
                    style={{ width: `${Math.min(100, Math.max(0, (gr + 0.15) / 0.55) * 100)}%` }}
                  />
                </div>
                <span className="w-10 text-right tabular-nums text-[0.65rem] text-foreground">
                  {gr >= 0 ? '+' : ''}{(gr * 100).toFixed(0)}%
                </span>
              </div>
            )}
            <p className="text-[0.6rem] text-muted-foreground">
              {isGrowth
                ? 'Strong growth potential based on character popularity, rarity scarcity, and trend momentum. May appreciate despite current overvaluation.'
                : gr != null && gr >= 0.05
                  ? 'Moderate growth expected. Character has steady collector interest.'
                  : 'Limited growth signal. Price may be stable or declining.'}
            </p>
          </div>
        )
      })()}
    </div>
  )
}

function Explain({
  label,
  value,
  prefix = '',
  hint = 'Model or heuristic input.',
}: {
  label: string
  value: number | null | undefined
  prefix?: string
  hint?: string
}) {
  return (
    <div className="flex justify-between gap-2">
      <Tooltip>
        <TooltipTrigger className="cursor-help border-b border-dotted border-muted-foreground">
          {label}
        </TooltipTrigger>
        <TooltipContent>{hint}</TooltipContent>
      </Tooltip>
      <span>
        {prefix}
        {value != null ? (typeof value === 'number' ? value.toFixed(2) : value) : '—'}
      </span>
    </div>
  )
}

function AiScoreBadge({
  score,
  decision,
}: {
  score: number
  decision: 'BUY' | 'WATCH' | 'PASS'
}) {
  const pct = Math.round(Math.max(0, Math.min(1, score)) * 100)
  const cls =
    decision === 'BUY'
      ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
      : decision === 'WATCH'
        ? 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400'
        : 'border-border text-muted-foreground'
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-semibold', cls)}>
      <span className="tabular-nums">{pct}%</span>
      <span>{decision}</span>
    </span>
  )
}

function InvestmentInsightPanel({ insight }: { insight: CardInvestmentInsight }) {
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-border bg-muted/20 p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">AI investment view</p>
        <AiScoreBadge score={insight.composite_score} decision={insight.decision} />
      </div>
      <div className="space-y-1.5 text-xs">
        <SignalBar label="Momentum" value={insight.signal_breakdown.momentum} />
        <SignalBar label="Pop scarcity" value={insight.signal_breakdown.pop_scarcity} />
        <SignalBar label="Sentiment" value={insight.signal_breakdown.sentiment} />
        <SignalBar label="Lifecycle" value={insight.signal_breakdown.lifecycle} />
      </div>
      <div className="grid grid-cols-3 gap-1.5 text-xs sm:gap-2">
        <NegotiationCell label="Opening" value={insight.negotiation.opening_offer} tone="buy" />
        <NegotiationCell label="Ideal" value={insight.negotiation.ideal_price} tone="watch" />
        <NegotiationCell label="Max pay" value={insight.negotiation.max_pay} tone="pass" />
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{insight.thesis}</p>
      {!!insight.comparable_cards.length && (
        <p className="text-xs text-muted-foreground">Comparables: {insight.comparable_cards.join(' · ')}</p>
      )}
    </div>
  )
}

function SignalBar({ label, value }: { label: string; value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100)
  return (
    <div className="grid grid-cols-[4.5rem_1fr_2rem] items-center gap-1.5 sm:grid-cols-[6rem_1fr_2.5rem] sm:gap-2">
      <span className="text-muted-foreground">{label}</span>
      <div className="h-1.5 rounded bg-muted">
        <div className="h-1.5 rounded bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-right tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  )
}

function NegotiationCell({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'buy' | 'watch' | 'pass'
}) {
  const cls =
    tone === 'buy'
      ? 'border-emerald-500/35 bg-emerald-500/10'
      : tone === 'watch'
        ? 'border-amber-500/35 bg-amber-500/10'
        : 'border-red-500/35 bg-red-500/10'
  return (
    <div className={cn('rounded-md border px-2 py-1.5', cls)}>
      <p className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="tabular-nums font-semibold">${value.toFixed(2)}</p>
    </div>
  )
}

function ValuationBadge({ flag }: { flag: string | null | undefined }) {
  if (!flag) return <span className="text-muted-foreground">—</span>
  const f = flag.toUpperCase()
  if (f.includes('UNDERVALUED')) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-500/25 dark:text-emerald-400" title={flag}>
        <span className="text-[0.6rem]">▲</span> Buy
      </span>
    )
  }
  if (f.includes('GROWTH')) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-sky-500/15 px-2 py-0.5 text-xs font-semibold text-sky-700 ring-1 ring-inset ring-sky-500/25 dark:text-sky-400" title={flag}>
        <span className="text-[0.6rem]">⬆</span> Growth
      </span>
    )
  }
  if (f.includes('OVERVALUED')) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-red-500/15 px-2 py-0.5 text-xs font-semibold text-red-700 ring-1 ring-inset ring-red-500/25 dark:text-red-400" title={flag}>
        <span className="text-[0.6rem]">▼</span> Over
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-500/20 dark:text-amber-400" title={flag}>
      — Fair
    </span>
  )
}

function MiniSpark({ data }: { data: { p: number }[] }) {
  if (data.length < 2) return <span className="text-muted-foreground">—</span>

  const first = data[0].p
  const last = data[data.length - 1].p
  const min = Math.min(...data.map((d) => d.p))
  const max = Math.max(...data.map((d) => d.p))
  const changePct = first > 0 ? ((last - first) / first) * 100 : 0
  const up = changePct > 1
  const down = changePct < -1

  const yMin = min === max ? min * 0.95 : min
  const yMax = min === max ? max * 1.05 || 1 : max

  return (
    <div className="flex items-center gap-1.5">
      <div className={cn(
        'h-8 w-16 shrink-0',
        up ? 'text-emerald-500' : down ? 'text-red-500' : 'text-muted-foreground',
      )}>
        <LineChart data={data} width={64} height={32}>
          <YAxis type="number" domain={[yMin, yMax]} hide />
          <Line type="monotone" dataKey="p" stroke="currentColor" dot={false} strokeWidth={1.5} />
        </LineChart>
      </div>
      <div className="flex flex-col text-right">
        <span className={cn(
          'text-[0.6rem] font-semibold tabular-nums leading-tight',
          up ? 'text-emerald-600 dark:text-emerald-400' : down ? 'text-red-500' : 'text-muted-foreground',
        )}>
          {up ? '▲' : down ? '▼' : '—'}{Math.abs(changePct).toFixed(0)}%
        </span>
        <span className="text-[0.55rem] tabular-nums leading-tight text-muted-foreground">
          {min !== max ? `$${min.toFixed(0)}–${max.toFixed(0)}` : `$${min.toFixed(0)}`}
        </span>
      </div>
    </div>
  )
}

function hasGradedPrices(card: CardRow): boolean {
  return !!(card.pc_price_raw || card.pc_price_grade7 || card.pc_price_grade8 ||
    card.pc_price_grade9 || card.pc_price_grade95 || card.pc_price_psa10)
}

type GradeKey = 'raw' | '7' | '8' | '9' | '9.5' | '10' | 'bgs10'

const GRADE_OPTIONS: { key: GradeKey; label: string }[] = [
  { key: 'raw', label: 'Raw / Ungraded' },
  { key: '7', label: 'PSA 7' },
  { key: '8', label: 'PSA 8' },
  { key: '9', label: 'PSA 9' },
  { key: '9.5', label: 'PSA 9.5' },
  { key: '10', label: 'PSA 10' },
  { key: 'bgs10', label: 'BGS 10' },
]

function getGradePrice(card: CardRow, grade: GradeKey): number | null {
  switch (grade) {
    case 'raw': return card.pc_price_raw
    case '7': return card.pc_price_grade7
    case '8': return card.pc_price_grade8
    case '9': return card.pc_price_grade9
    case '9.5': return card.pc_price_grade95
    case '10': return card.pc_price_psa10
    case 'bgs10': return card.pc_price_bgs10
    default: return null
  }
}

function GradedPricesPanel({ card }: { card: CardRow }) {
  const [selectedGrade, setSelectedGrade] = useState<GradeKey>('raw')
  const selectedPrice = getGradePrice(card, selectedGrade)
  const rawPrice = card.pc_price_raw

  const available = GRADE_OPTIONS.filter(o => {
    const p = getGradePrice(card, o.key)
    return p != null && p > 0
  })

  if (available.length === 0) return null

  const gradingCost = 25
  const roiTarget = selectedGrade !== 'raw' && rawPrice && rawPrice > 0 && selectedPrice
    ? ((selectedPrice - gradingCost - rawPrice) / rawPrice) * 100
    : null

  return (
    <div className="mt-2 rounded-md border border-border/60 bg-muted/15 p-2.5">
      <p className="mb-2 text-xs font-semibold text-foreground">PriceCharting — graded prices</p>
      <div className="grid grid-cols-2 gap-1.5 text-xs sm:grid-cols-3">
        {available.map(({ key, label }) => {
          const price = getGradePrice(card, key)!
          const isSelected = key === selectedGrade
          return (
            <button
              key={key}
              type="button"
              onClick={() => setSelectedGrade(key)}
              className={cn(
                'rounded-md border px-2 py-1.5 text-left transition-colors',
                isSelected
                  ? 'border-primary bg-primary/10 ring-1 ring-primary/30'
                  : 'border-border/60 hover:bg-muted/40',
              )}
            >
              <p className="text-[0.65rem] text-muted-foreground">{label}</p>
              <p className="tabular-nums font-semibold">${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
            </button>
          )
        })}
      </div>
      {roiTarget != null && rawPrice != null && rawPrice > 0 && (
        <div className="mt-2 rounded-md border border-border/40 bg-background/60 px-2 py-1.5 text-xs">
          <span className="text-muted-foreground">Grading ROI ({GRADE_OPTIONS.find(o => o.key === selectedGrade)?.label}): </span>
          <span className={cn('font-semibold tabular-nums', roiTarget >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500')}>
            {roiTarget >= 0 ? '+' : ''}{roiTarget.toFixed(1)}%
          </span>
          <span className="text-muted-foreground"> · Raw ${rawPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} → graded ${selectedPrice!.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} − $25 grading</span>
        </div>
      )}
    </div>
  )
}

function PsaRoi({ cardName, rawPrice }: { cardName: string; rawPrice: number }) {
  const [grade, _setGrade] = useState<PsaGradePersisted>(() => loadPsaGrade())
  const setGrade = (g: PsaGradePersisted) => { _setGrade(g); savePsaGrade(g) }
  const gradingCost = 25
  const estimatedGraded = rawPrice * (grade === '10' ? 2.4 : 1.6)
  const roi = rawPrice > 0 ? ((estimatedGraded - gradingCost - rawPrice) / rawPrice) * 100 : 0

  return (
    <div className="mt-6 space-y-3 rounded-lg border border-border p-3">
      <div className="flex items-center gap-1">
        <p className="font-medium">PSA grading ROI (estimate)</p>
        <HelpButton sectionId="cards-psa-roi" />
      </div>
      <p className="text-xs text-muted-foreground">Uses condition-adjusted raw value when set above.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <Label>Target grade</Label>
          <select
            className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
            value={grade}
            onChange={(e) => setGrade(e.target.value as PsaGradePersisted)}
          >
            <option value="9">PSA 9</option>
            <option value="10">PSA 10</option>
          </select>
        </div>
        <div>
          <Label>Card</Label>
          <p className="mt-1 text-sm text-muted-foreground">{cardName}</p>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Assumes graded value ≈ {grade === '10' ? '2.4×' : '1.6×'} raw (TCGPlayer-style heuristic), ${gradingCost}{' '}
        economy grading.
      </p>
      <p className="text-sm">
        Est. ROI: <strong>{roi.toFixed(1)}%</strong> · Est. graded resale:{' '}
        <strong>${estimatedGraded.toFixed(2)}</strong>
      </p>
    </div>
  )
}
