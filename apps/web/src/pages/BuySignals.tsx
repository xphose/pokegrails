import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ZoomIn } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { UpgradeBanner } from '@/components/UpgradeBanner'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { SetMetaTooltipBody } from '@/components/set-meta-tooltip'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api, buildCardSearchQuery, type CardFiltersMeta, type CardRow, type SetMeta } from '@/lib/api'
import {
  cardsFiltersToSearchParams,
  loadSignalsSetFilter,
  loadSignalsSort,
  saveSignalsSetFilter,
  saveSignalsSort,
  type CardsFiltersPersisted,
  type SignalsSort,
} from '@/lib/ui-persist'
import { HelpButton } from '@/components/help-center'

function cardsLink(partial: Partial<CardsFiltersPersisted>): string {
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

const SORT_OPTIONS: { value: SignalsSort; label: string; hint: string }[] = [
  { value: 'discount', label: 'Best discount (% vs fair)', hint: 'Highest % below model fair value' },
  { value: 'dollar', label: 'Most savings ($)', hint: 'Largest gap fair value minus market' },
  { value: 'market', label: 'Lowest market price', hint: 'Cheapest listings first' },
  { value: 'fair', label: 'Highest fair value', hint: 'Big-ticket hits the model cares about' },
  { value: 'name', label: 'Name A–Z', hint: 'Alphabetical by card name' },
  { value: 'set', label: 'By set (A–Z)', hint: 'Sort by expansion code, then card name' },
]

export function BuySignals() {
  const [sort, setSort] = useState<SignalsSort>(() => loadSignalsSort())
  const [setFilter, setSetFilter] = useState(() => loadSignalsSetFilter())
  const [zoom, setZoom] = useState<{ url: string; name: string } | null>(null)

  const metaQuery = useQuery({
    queryKey: ['api', 'meta', 'card-filters', ''],
    queryFn: () => api<CardFiltersMeta>('/api/meta/card-filters'),
    staleTime: 60_000,
  })
  const meta = metaQuery.data ?? null

  const signalsQuery = useQuery({
    queryKey: ['api', 'signals', sort, setFilter],
    queryFn: () => {
      const qs = new URLSearchParams()
      qs.set('sort', sort)
      if (setFilter) qs.set('set_id', setFilter)
      return api<CardRow[]>(`/api/signals?${qs.toString()}`)
    },
    staleTime: 45_000,
  })
  const rows = signalsQuery.data ?? []
  const loading = signalsQuery.isPending
  const error = signalsQuery.error instanceof Error ? signalsQuery.error.message : null

  useEffect(() => {
    saveSignalsSort(sort)
  }, [sort])

  useEffect(() => {
    saveSignalsSetFilter(setFilter)
  }, [setFilter])

  useEffect(() => {
    if (!meta?.setIds?.length) return
    if (setFilter && !meta.setIds.includes(setFilter)) {
      setSetFilter('')
    }
  }, [meta?.setIds, setFilter])

  const setById = useMemo(() => {
    const m = new Map<string, SetMeta>()
    for (const s of meta?.sets ?? []) m.set(s.id, s)
    return m
  }, [meta?.sets])

  useEffect(() => {
    if (!zoom) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoom(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoom])

  const addWatch = async (id: string) => {
    await api('/api/watchlist', {
      method: 'POST',
      body: JSON.stringify({ card_id: id, alert_active: 1 }),
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-3 sm:p-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-1">
            <h1 className="text-lg font-semibold">Buy signals</h1>
            <HelpButton sectionId="signals-overview" />
          </div>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground sm:text-sm">
            Undervalued candidates ranked by discount, savings, price, or set.
          </p>
          <div className="mt-2"><UpgradeBanner /></div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:flex sm:flex-wrap sm:items-center">
          <div className="flex flex-col gap-1">
            <Label htmlFor="sig-set">Set</Label>
            <select
              id="sig-set"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm sm:w-auto sm:min-w-[14rem]"
              value={setFilter}
              onChange={(e) => setSetFilter(e.target.value)}
              disabled={!meta}
              title="Limit signals to one expansion"
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
            <Label htmlFor="sig-sort">Sort by</Label>
            <select
              id="sig-sort"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm sm:w-auto sm:min-w-[14rem]"
              value={sort}
              onChange={(e) => setSort(e.target.value as SignalsSort)}
              title={SORT_OPTIONS.find((o) => o.value === sort)?.hint}
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} title={o.hint}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => signalsQuery.refetch()}
            disabled={loading}
          >
            Refresh
          </Button>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        {loading ? 'Loading…' : `${rows.length} signal${rows.length === 1 ? '' : 's'} (max 200)`}
      </p>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((c) => {
          const fair = c.predicted_price ?? 0
          const mkt = c.market_price ?? 0
          const disc = fair > 0 && mkt > 0 ? ((fair - mkt) / fair) * 100 : 0
          const saveUsd = fair > 0 && mkt > 0 ? fair - mkt : 0
          const setMetaRow = c.set_id ? setById.get(c.set_id) : undefined
          return (
            <Card
              key={c.id}
              className="group overflow-hidden border-emerald-500/30 transition-shadow hover:border-emerald-500/50 hover:shadow-md"
            >
              <CardHeader className="flex flex-row items-start gap-3 pb-2">
                {c.image_url ? (
                  <div className="relative shrink-0">
                    <img
                      src={c.image_url}
                      alt=""
                      className="h-28 w-auto max-w-[9rem] rounded border border-border object-contain"
                    />
                    <button
                      type="button"
                      className="absolute right-1 bottom-1 flex size-8 items-center justify-center rounded-md border border-border bg-background/90 text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-muted"
                      title="Enlarge artwork"
                      aria-label="Enlarge card image"
                      onClick={() => setZoom({ url: c.image_url!, name: c.name })}
                    >
                      <ZoomIn className="size-4" />
                    </button>
                  </div>
                ) : (
                  <div className="flex h-28 w-20 shrink-0 items-center justify-center rounded border border-dashed border-border text-xs text-muted-foreground">
                    No art
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <CardTitle className="text-base leading-snug">{c.name}</CardTitle>
                  {c.set_id && (
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      Set{' '}
                      {setMetaRow ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Link
                                className="text-primary hover:underline"
                                to={cardsLink({ set_id: c.set_id! })}
                              >
                                <span className="text-muted-foreground">{c.set_id}</span>
                                {' — '}
                                <span className="text-foreground">{setMetaRow.name ?? c.set_id}</span>
                              </Link>
                            }
                          />
                          <TooltipContent side="top" align="start" className="max-w-xs">
                            <SetMetaTooltipBody s={setMetaRow} />
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <Link className="text-primary hover:underline" to={cardsLink({ set_id: c.set_id })}>
                          {c.set_id}
                        </Link>
                      )}
                    </p>
                  )}
                  <Badge className="mt-2 bg-emerald-600 text-white hover:bg-emerald-600">
                    {disc.toFixed(1)}% below fair
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-1 text-sm text-muted-foreground">
                <p>
                  Fair value (model): <span className="font-medium text-foreground">${fair.toFixed(2)}</span>
                </p>
                <p>
                  Market: <span className="font-medium text-foreground">${mkt.toFixed(2)}</span>
                </p>
                <p>
                  Est. savings:{' '}
                  <span className="font-medium text-emerald-600 dark:text-emerald-400">${saveUsd.toFixed(2)}</span>
                </p>
                <p className="text-xs">Undervalued since: {c.undervalued_since ?? 'n/a'}</p>
              </CardContent>
              <CardFooter className="flex flex-wrap gap-2 border-t border-border/60 pt-4">
                <Link
                  className={cn(buttonVariants({ variant: 'default', size: 'sm' }))}
                  to={cardsLink({
                    q: c.name.length > 48 ? c.name.slice(0, 48) : c.name,
                    sort: 'market_price',
                    order: 'desc',
                  })}
                >
                  Open in Cards
                </Link>
                <a
                  className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}
                  href={`https://www.tcgplayer.com/search/pokemon/product?q=${encodeURIComponent(buildCardSearchQuery(c.name, c.id, c.set_id ? setById.get(c.set_id)?.name : null, ''))}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  TCGPlayer
                </a>
                <a
                  className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}
                  href={`https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(buildCardSearchQuery(c.name, c.id, c.set_id ? setById.get(c.set_id)?.name : null))}&LH_Sold=1&LH_Complete=1`}
                  target="_blank"
                  rel="noreferrer"
                >
                  eBay
                </a>
                <Button size="sm" type="button" variant="outline" onClick={() => addWatch(c.id)}>
                  Add to watchlist
                </Button>
              </CardFooter>
            </Card>
          )
        })}
      </div>

      {!loading && !rows.length && !error && (
        <p className="text-muted-foreground">No buy signals yet — run ingest and refresh the model.</p>
      )}

      {zoom && (
        <button
          type="button"
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center border-0 bg-black/85 p-4"
          aria-label="Close enlarged image"
          onClick={() => setZoom(null)}
        >
          <span
            className="max-h-[min(90vh,900px)] max-w-[min(96vw,520px)]"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="presentation"
          >
            <img src={zoom.url} alt={zoom.name} className="max-h-[85vh] w-full rounded-lg object-contain shadow-2xl" />
            <p className="mt-3 text-center text-sm text-white/90">{zoom.name}</p>
            <p className="mt-1 text-center text-xs text-white/60">Click outside or press Esc to close</p>
          </span>
        </button>
      )}
    </div>
  )
}
