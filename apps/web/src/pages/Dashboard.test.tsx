import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CardRow } from '@/lib/api'
import { Dashboard } from './Dashboard'
import { AuthProvider } from '@/lib/auth'

function makeCard(overrides: Partial<CardRow>): CardRow {
  return {
    id: 'card-1',
    name: 'Pikachu V',
    set_id: 'sv1',
    rarity: 'Rare',
    card_type: 'Pokemon',
    image_url: null,
    pull_cost_score: null,
    desirability_score: null,
    predicted_price: null,
    market_price: null,
    ebay_median: null,
    valuation_flag: null,
    reddit_buzz_score: null,
    trends_score: null,
    explain_json: null,
    undervalued_since: null,
    future_value_12m: null,
    annual_growth_rate: null,
    pc_price_raw: null,
    pc_price_grade7: null,
    pc_price_grade8: null,
    pc_price_grade9: null,
    pc_price_grade95: null,
    pc_price_psa10: null,
    pc_price_bgs10: null,
    ...overrides,
  }
}

type DashboardApiFixture = {
  cards: CardRow[]
  dashboard?: { totalCards: number; undervaluedSignals: number; avgModelAccuracy: number; portfolioValue: number }
  upcoming?: { id: string; name: string; release_date: string }[]
  meta?: { sets: { id: string; name: string | null }[]; setIds: string[]; printBuckets: string[] }
  sets?: { id: string; name: string; rip_or_singles_verdict: string | null }[]
}

function mockDashboardApi(fixture: DashboardApiFixture) {
  const payloads = {
    '/api/dashboard': fixture.dashboard ?? {
      totalCards: fixture.cards.length,
      undervaluedSignals: 0,
      avgModelAccuracy: 0.88,
      portfolioValue: 0,
    },
    '/api/cards?limit=5000&offset=0&slim=1': {
      items: fixture.cards,
      total: fixture.cards.length,
      limit: 5000,
      offset: 0,
    },
    '/api/upcoming': fixture.upcoming ?? [],
    '/api/meta/card-filters': fixture.meta ?? { sets: [], setIds: [], printBuckets: [] },
    '/api/sets': fixture.sets ?? [],
  } as const

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/auth/')) {
        return new Response(JSON.stringify({ error: 'not authenticated' }), { status: 401 })
      }
      const hit = Object.entries(payloads).find(([path]) => url.endsWith(path))
      if (!hit) return new Response('not found', { status: 404 })
      return new Response(JSON.stringify(hit[1]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }),
  )
}

function renderDashboard() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AuthProvider>
          <Dashboard />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Dashboard data tabs', () => {
  beforeEach(() => {
    try { localStorage.clear() } catch { /* jsdom fallback */ }
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows social momentum with trends fallback (not just rounded reddit buzz)', async () => {
    mockDashboardApi({
      cards: [
        makeCard({
          id: 'c1',
          name: 'Charizard ex',
          market_price: 22,
          predicted_price: 25,
          reddit_buzz_score: 0,
          trends_score: 9,
        }),
        makeCard({
          id: 'c2',
          name: 'Pikachu V',
          market_price: 12,
          predicted_price: 14,
          reddit_buzz_score: 0.4,
          trends_score: 8,
        }),
      ],
    })
    renderDashboard()

    await screen.findByText('Social momentum')
    expect(screen.queryByText('Waiting for social signals (Reddit and trends)…')).not.toBeInTheDocument()
    expect(screen.getByText('Charizard ex')).toBeInTheDocument()
    expect(screen.getByText('Pikachu V')).toBeInTheDocument()
    expect(screen.getByText('63/100')).toBeInTheDocument()
    expect(screen.getByText('56/100')).toBeInTheDocument()
  })

  it('renders empty states for each chart tab when there is no data', async () => {
    mockDashboardApi({
      cards: [makeCard({ id: 'no-data', name: 'No Data Card', market_price: 10 })],
    })
    renderDashboard()

    const user = userEvent.setup()
    const chartSelect = await screen.findByLabelText('Chart type')

    expect(screen.getByText(/No points match your filters/i)).toBeInTheDocument()

    await user.selectOptions(chartSelect, 'fair_market')
    expect(screen.getByText(/No cards with both a list price and model price/i)).toBeInTheDocument()

    await user.selectOptions(chartSelect, 'deal_mix')
    expect(
      screen.getByText(/No cards are currently priced below model fair value after filters/i),
    ).toBeInTheDocument()

    await user.selectOptions(chartSelect, 'sets_rank')
    expect(screen.getByText(/No sets have enough singles over your/i)).toBeInTheDocument()
  })

  it('renders populated chart tabs when backing data exists', async () => {
    mockDashboardApi({
      cards: [
        makeCard({
          id: 'rich-1',
          name: 'Umbreon VMAX',
          set_id: 'sv8',
          pull_cost_score: 8,
          desirability_score: 9,
          predicted_price: 100,
          market_price: 60,
          valuation_flag: 'UNDERVALUED',
          reddit_buzz_score: 4,
          trends_score: 9,
        }),
      ],
      meta: {
        sets: [{ id: 'sv8', name: 'Surging Sparks' }],
        setIds: ['sv8'],
        printBuckets: [],
      },
    })
    renderDashboard()

    const user = userEvent.setup()
    const chartSelect = await screen.findByLabelText('Chart type')

    expect(screen.queryByText(/No points match your filters/i)).not.toBeInTheDocument()

    await user.selectOptions(chartSelect, 'fair_market')
    await waitFor(() => {
      expect(screen.queryByText(/No cards with both a list price and model price/i)).not.toBeInTheDocument()
    })

    await user.selectOptions(chartSelect, 'deal_mix')
    await waitFor(() => {
      expect(
        screen.queryByText(/No cards are currently priced below model fair value after filters/i),
      ).not.toBeInTheDocument()
    })

    await user.selectOptions(chartSelect, 'sets_rank')
    await waitFor(() => {
      expect(screen.queryByText(/No sets have enough singles over your/i)).not.toBeInTheDocument()
    })
  })
})
