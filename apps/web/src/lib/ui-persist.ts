/** Cross-tab UI persistence (localStorage). */

const CARDS_FILTERS = 'pokeedge_cards_filters'
const SETS_VERDICT_FILTER = 'pokeedge_sets_verdict_filter'

export type CardsFiltersPersisted = {
  q: string
  set_id: string
  print: string
  sort: string
  order: 'asc' | 'desc'
  flagFilter: string
}

const defaultCards: CardsFiltersPersisted = {
  q: '',
  set_id: '',
  print: '',
  sort: 'market_price',
  order: 'desc',
  flagFilter: '',
}

function parseOrder(s: string | null): 'asc' | 'desc' {
  return s === 'asc' ? 'asc' : 'desc'
}

/** Read Cards filters present in URL (only keys that appear in the query). */
export function readCardsFiltersFromSearchParams(search: string): Partial<CardsFiltersPersisted> | null {
  const params = new URLSearchParams(search)
  if ([...params.keys()].length === 0) return null
  const out: Partial<CardsFiltersPersisted> = {}
  if (params.has('q')) out.q = params.get('q') ?? ''
  if (params.has('set_id')) out.set_id = params.get('set_id') ?? ''
  if (params.has('print')) out.print = params.get('print') ?? ''
  if (params.has('sort')) out.sort = params.get('sort') ?? 'market_price'
  if (params.has('order')) out.order = parseOrder(params.get('order'))
  if (params.has('flag')) out.flagFilter = params.get('flag') ?? ''
  return out
}

export function cardsFiltersToSearchParams(f: CardsFiltersPersisted): URLSearchParams {
  const p = new URLSearchParams()
  if (f.q) p.set('q', f.q)
  if (f.set_id) p.set('set_id', f.set_id)
  if (f.print) p.set('print', f.print)
  p.set('sort', f.sort || 'market_price')
  p.set('order', f.order || 'desc')
  if (f.flagFilter) p.set('flag', f.flagFilter)
  return p
}

/** Compare query strings regardless of parameter order. */
export function searchParamsEqual(a: string, b: string): boolean {
  const A = new URLSearchParams(a)
  const B = new URLSearchParams(b)
  const keys = new Set([...A.keys(), ...B.keys()])
  for (const k of keys) {
    if (A.get(k) !== B.get(k)) return false
  }
  return true
}

export function loadCardsFilters(): CardsFiltersPersisted {
  try {
    const raw = localStorage.getItem(CARDS_FILTERS)
    if (!raw) return { ...defaultCards }
    const j = JSON.parse(raw) as Partial<CardsFiltersPersisted>
    return {
      ...defaultCards,
      ...j,
      order: j.order === 'asc' ? 'asc' : 'desc',
      flagFilter: typeof j.flagFilter === 'string' ? j.flagFilter : '',
    }
  } catch {
    return { ...defaultCards }
  }
}

export function saveCardsFilters(f: CardsFiltersPersisted) {
  try {
    localStorage.setItem(CARDS_FILTERS, JSON.stringify(f))
  } catch {
    /* ignore */
  }
}

export function getInitialCardsFilters(search: string): CardsFiltersPersisted {
  const saved = loadCardsFilters()
  const base: CardsFiltersPersisted = { ...defaultCards, ...saved }
  const fromUrl = readCardsFiltersFromSearchParams(search)
  if (!fromUrl) return base
  return {
    q: fromUrl.q !== undefined ? fromUrl.q : base.q,
    set_id: fromUrl.set_id !== undefined ? fromUrl.set_id : base.set_id,
    print: fromUrl.print !== undefined ? fromUrl.print : base.print,
    sort: fromUrl.sort !== undefined ? fromUrl.sort : base.sort,
    order: fromUrl.order !== undefined ? fromUrl.order : base.order,
    flagFilter: fromUrl.flagFilter !== undefined ? fromUrl.flagFilter : base.flagFilter,
  }
}

export type SetsVerdictFilter = 'all' | 'buy_singles' | 'rip' | 'rip_caution' | 'hold_sealed' | 'breakeven'

export function loadSetsVerdictFilter(): SetsVerdictFilter {
  try {
    const v = localStorage.getItem(SETS_VERDICT_FILTER) as SetsVerdictFilter | null
    if (v === 'all' || v === 'buy_singles' || v === 'rip' || v === 'rip_caution' || v === 'hold_sealed' || v === 'breakeven') return v
  } catch {
    /* ignore */
  }
  return 'all'
}

export function saveSetsVerdictFilter(v: SetsVerdictFilter) {
  try {
    localStorage.setItem(SETS_VERDICT_FILTER, v)
  } catch {
    /* ignore */
  }
}

const WATCHLIST_FORM = 'pokeedge_watchlist_form'

export type WatchlistFormPersisted = { cardId: string; target: string }

export function loadWatchlistForm(): WatchlistFormPersisted {
  try {
    const raw = localStorage.getItem(WATCHLIST_FORM)
    if (!raw) return { cardId: '', target: '' }
    const j = JSON.parse(raw) as Partial<WatchlistFormPersisted>
    return { cardId: j.cardId ?? '', target: j.target ?? '' }
  } catch {
    return { cardId: '', target: '' }
  }
}

export function saveWatchlistForm(f: WatchlistFormPersisted) {
  try {
    localStorage.setItem(WATCHLIST_FORM, JSON.stringify(f))
  } catch {
    /* ignore */
  }
}

const DASH_PREFS = 'pokeedge_dashboard_prefs'

export type DashboardValuationFilter = 'all' | 'under' | 'over' | 'fair' | 'growth'

/** Which main visualization to show — each answers a different question. */
export type DashboardChartKind =
  | 'pull_desire'
  | 'fair_market'
  | 'deal_mix'
  | 'sets_rank'

export type DashboardBubbleScale = 's' | 'm' | 'l'

export type DashboardPrefs = {
  scatterSetId: string
  valuation: DashboardValuationFilter
  chartKind: DashboardChartKind
  /**
   * Only emphasize cards at or above this % off model fair (0–60).
   * Does not change server math — helps you focus the chart.
   */
  minDealPercent: number
  /**
   * Hide very cheap singles where small $ gaps look huge in % terms.
   */
  minFairValueUsd: number
  bubbleScale: DashboardBubbleScale
  /** Card id selected (dot clicked) on scatter chart — survives navigation. */
  selectedId: string | null
}

const defaultDash: DashboardPrefs = {
  scatterSetId: '',
  valuation: 'all',
  chartKind: 'pull_desire',
  minDealPercent: 5,
  minFairValueUsd: 2,
  bubbleScale: 'm',
  selectedId: null,
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

export function loadDashboardPrefs(): DashboardPrefs {
  try {
    const raw = localStorage.getItem(DASH_PREFS)
    if (!raw) return { ...defaultDash }
    const j = JSON.parse(raw) as Partial<DashboardPrefs>
    const v = j.valuation
    const valuation: DashboardValuationFilter =
      v === 'under' || v === 'over' || v === 'fair' || v === 'all' || v === 'growth' ? v : 'all'
    const ck = j.chartKind
    const chartKind: DashboardChartKind =
      ck === 'pull_desire' || ck === 'fair_market' || ck === 'deal_mix' || ck === 'sets_rank' ? ck : 'pull_desire'
    const minDealPercent =
      typeof j.minDealPercent === 'number' && Number.isFinite(j.minDealPercent)
        ? clamp(j.minDealPercent, 0, 60)
        : defaultDash.minDealPercent
    const minFairValueUsd =
      typeof j.minFairValueUsd === 'number' && Number.isFinite(j.minFairValueUsd)
        ? clamp(j.minFairValueUsd, 0, 500)
        : defaultDash.minFairValueUsd
    const bubbleScale: DashboardBubbleScale =
      j.bubbleScale === 's' || j.bubbleScale === 'm' || j.bubbleScale === 'l' ? j.bubbleScale : 'm'
    return {
      scatterSetId: typeof j.scatterSetId === 'string' ? j.scatterSetId : '',
      valuation,
      chartKind,
      minDealPercent,
      minFairValueUsd,
      bubbleScale,
      selectedId: typeof j.selectedId === 'string' ? j.selectedId : null,
    }
  } catch {
    return { ...defaultDash }
  }
}

export function saveDashboardPrefs(p: DashboardPrefs) {
  try {
    localStorage.setItem(DASH_PREFS, JSON.stringify(p))
  } catch {
    /* ignore */
  }
}

const SIGNALS_SORT = 'pokeedge_signals_sort'
const SIGNALS_SET = 'pokeedge_signals_set_id'

export type SignalsSort = 'discount' | 'dollar' | 'market' | 'fair' | 'name' | 'set'

export function loadSignalsSort(): SignalsSort {
  try {
    const v = localStorage.getItem(SIGNALS_SORT) as SignalsSort | null
    if (
      v === 'discount' ||
      v === 'dollar' ||
      v === 'market' ||
      v === 'fair' ||
      v === 'name' ||
      v === 'set'
    )
      return v
  } catch {
    /* ignore */
  }
  return 'discount'
}

export function saveSignalsSort(s: SignalsSort) {
  try {
    localStorage.setItem(SIGNALS_SORT, s)
  } catch {
    /* ignore */
  }
}

export function loadSignalsSetFilter(): string {
  try {
    const v = localStorage.getItem(SIGNALS_SET)
    return typeof v === 'string' ? v : ''
  } catch {
    return ''
  }
}

export function saveSignalsSetFilter(setId: string) {
  try {
    localStorage.setItem(SIGNALS_SET, setId)
  } catch {
    /* ignore */
  }
}

const CARDS_TREND_WINDOW = 'pokeedge_cards_trend_window'

export type TrendWindowPersisted = '1m' | '3m' | '6m' | '1y' | 'all'

const VALID_TREND: Set<string> = new Set(['1m', '3m', '6m', '1y', 'all'])

export function loadTrendWindow(): TrendWindowPersisted {
  try {
    const v = localStorage.getItem(CARDS_TREND_WINDOW)
    if (v && VALID_TREND.has(v)) return v as TrendWindowPersisted
  } catch {
    /* ignore */
  }
  return '6m'
}

export function saveTrendWindow(w: TrendWindowPersisted) {
  try {
    localStorage.setItem(CARDS_TREND_WINDOW, w)
  } catch {
    /* ignore */
  }
}

const PSA_GRADE = 'pokeedge_psa_grade'

export type PsaGradePersisted = '9' | '10'

export function loadPsaGrade(): PsaGradePersisted {
  try {
    const v = localStorage.getItem(PSA_GRADE)
    if (v === '9' || v === '10') return v
  } catch {
    /* ignore */
  }
  return '10'
}

export function savePsaGrade(g: PsaGradePersisted) {
  try {
    localStorage.setItem(PSA_GRADE, g)
  } catch {
    /* ignore */
  }
}

const SETS_SELECTED = 'pokeedge_sets_selected_id'

export function loadSetsSelectedId(): string | null {
  try {
    const v = localStorage.getItem(SETS_SELECTED)
    return typeof v === 'string' && v ? v : null
  } catch {
    return null
  }
}

export function saveSetsSelectedId(id: string | null) {
  try {
    if (id) localStorage.setItem(SETS_SELECTED, id)
    else localStorage.removeItem(SETS_SELECTED)
  } catch {
    /* ignore */
  }
}

const TRACK_RECORD_TAB = 'pokeedge_track_record_tab'

export type TrackRecordTab = 'overview' | 'charts' | 'accuracy' | 'signals'

const VALID_TR_TABS: Set<string> = new Set(['overview', 'charts', 'accuracy', 'signals'])

export function loadTrackRecordTab(): TrackRecordTab {
  try {
    const v = localStorage.getItem(TRACK_RECORD_TAB)
    if (v && VALID_TR_TABS.has(v)) return v as TrackRecordTab
  } catch {
    /* ignore */
  }
  return 'overview'
}

export function saveTrackRecordTab(tab: TrackRecordTab) {
  try {
    localStorage.setItem(TRACK_RECORD_TAB, tab)
  } catch {
    /* ignore */
  }
}
