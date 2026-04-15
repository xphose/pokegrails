import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { AnalyticsPage } from './Analytics'

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  )
}

const mockModelStatus = [
  { name: 'Gradient Boost', model_id: 'gradient-boost', last_run: '2025-01-01T00:00:00Z', card_coverage: 100, total_cards: 100, status: 'ready' },
  { name: 'Feature Importance (RF)', model_id: 'random-forest', last_run: null, card_coverage: 100, total_cards: 100, status: 'not_run' },
  { name: 'Time-Series Forecast', model_id: 'timeseries', last_run: null, card_coverage: 50, total_cards: 100, status: 'not_run' },
  { name: 'Sentiment Analysis', model_id: 'sentiment', last_run: null, card_coverage: 100, total_cards: 100, status: 'ready' },
]

const mockProgress = { running: false, current_model: null, completed: [], queued: [], total: 0, started_at: null, elapsed_ms: 0, finished_at: null, error: null }

function mockFetchForUrls() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    if (url.includes('/api/models/progress')) {
      return { ok: true, json: async () => mockProgress } as Response
    }
    return { ok: true, json: async () => mockModelStatus } as Response
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('Analytics Page', () => {
  it('renders page title and tabs', () => {
    mockFetchForUrls()
    render(<AnalyticsPage />, { wrapper })
    expect(screen.getByText('Analytics')).toBeInTheDocument()
    expect(screen.getByText('Model Status')).toBeInTheDocument()
    expect(screen.getByText('Momentum Watch')).toBeInTheDocument()
    expect(screen.getByText('Market Intelligence')).toBeInTheDocument()
    expect(screen.getByText('Market Events')).toBeInTheDocument()
    expect(screen.getByText('Archetypes')).toBeInTheDocument()
  })

  it('renders model status cards when data loads', async () => {
    mockFetchForUrls()
    render(<AnalyticsPage />, { wrapper })

    await waitFor(() => {
      expect(screen.getByText('Gradient Boost')).toBeInTheDocument()
      expect(screen.getByText('Time-Series Forecast')).toBeInTheDocument()
    })
  })

  it('shows Run All button', async () => {
    mockFetchForUrls()
    render(<AnalyticsPage />, { wrapper })

    await waitFor(() => {
      expect(screen.getByText('Run All Models')).toBeInTheDocument()
    })
  })

  it('renders batch and on-demand group headings', async () => {
    mockFetchForUrls()
    render(<AnalyticsPage />, { wrapper })

    await waitFor(() => {
      expect(screen.getByText('Batch Models')).toBeInTheDocument()
      expect(screen.getByText('On-Demand Models')).toBeInTheDocument()
    })
  })

  it('shows Per Card badge for on-demand models', async () => {
    mockFetchForUrls()
    render(<AnalyticsPage />, { wrapper })

    await waitFor(() => {
      const perCardBadges = screen.getAllByText('Per Card')
      expect(perCardBadges.length).toBeGreaterThan(0)
    })
  })

  it('handles empty API response gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/api/models/progress')) {
        return { ok: true, json: async () => mockProgress } as Response
      }
      return { ok: true, json: async () => [] } as Response
    })

    render(<AnalyticsPage />, { wrapper })

    await waitFor(() => {
      expect(screen.getByText('Model Status')).toBeInTheDocument()
    })
  })

  it('shows Run individual buttons on each batch model card', async () => {
    mockFetchForUrls()
    render(<AnalyticsPage />, { wrapper })

    await waitFor(() => {
      const runButtons = screen.getAllByText('Run')
      expect(runButtons.length).toBeGreaterThanOrEqual(1)
    })
  })

  it('Run All Models button is not disabled when idle', async () => {
    mockFetchForUrls()
    render(<AnalyticsPage />, { wrapper })

    await waitFor(() => {
      const btn = screen.getByText('Run All Models')
      expect(btn).not.toBeDisabled()
    })
  })

  it('shows status badges (Ready, Not Run) on model cards', async () => {
    mockFetchForUrls()
    render(<AnalyticsPage />, { wrapper })

    await waitFor(() => {
      expect(screen.getAllByText('Ready').length).toBeGreaterThan(0)
      expect(screen.getAllByText('Not Run').length).toBeGreaterThan(0)
    })
  })

  it('shows progress bar and queued models during active run', async () => {
    const activeProgress = {
      running: true,
      current_model: 'gradient-boost',
      completed: [{ id: 'random-forest', duration_ms: 1500 }],
      queued: ['clustering', 'pca'],
      total: 4,
      started_at: new Date().toISOString(),
      elapsed_ms: 3200,
      finished_at: null,
      error: null,
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/api/models/progress')) {
        return { ok: true, json: async () => activeProgress } as Response
      }
      return { ok: true, json: async () => mockModelStatus } as Response
    })

    render(<AnalyticsPage />, { wrapper })

    await waitFor(() => {
      expect(screen.getByText(/Running 1\/4/)).toBeInTheDocument()
    })
  })

  it('shows completion summary after run finishes', async () => {
    const finishedProgress = {
      running: false,
      current_model: null,
      completed: [
        { id: 'gradient-boost', duration_ms: 2500 },
        { id: 'random-forest', duration_ms: 1800 },
      ],
      queued: [],
      total: 2,
      started_at: new Date().toISOString(),
      elapsed_ms: 5000,
      finished_at: new Date().toISOString(),
      error: null,
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/api/models/progress')) {
        return { ok: true, json: async () => finishedProgress } as Response
      }
      return { ok: true, json: async () => mockModelStatus } as Response
    })

    render(<AnalyticsPage />, { wrapper })

    await waitFor(() => {
      expect(screen.getByText(/All 2 models completed/)).toBeInTheDocument()
      expect(screen.getByText('Dismiss')).toBeInTheDocument()
    })
  })

  it('shows error banner when run fails', async () => {
    const errorProgress = {
      running: false,
      current_model: null,
      completed: [{ id: 'gradient-boost', duration_ms: 2500 }],
      queued: [],
      total: 2,
      started_at: new Date().toISOString(),
      elapsed_ms: 3000,
      finished_at: new Date().toISOString(),
      error: 'Clustering model failed: out of memory',
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/api/models/progress')) {
        return { ok: true, json: async () => errorProgress } as Response
      }
      return { ok: true, json: async () => mockModelStatus } as Response
    })

    render(<AnalyticsPage />, { wrapper })

    await waitFor(() => {
      expect(screen.getByText(/Clustering model failed/)).toBeInTheDocument()
    })
  })

  it('shows card search input for on-demand models', async () => {
    mockFetchForUrls()
    render(<AnalyticsPage />, { wrapper })

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Search for a card/)).toBeInTheDocument()
    })
  })
})
