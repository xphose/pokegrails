import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Layout } from './Layout'

const mockAuthValue = {
  user: null as { id: number; username: string; email: string; role: string } | null,
  loading: false,
  login: vi.fn(),
  register: vi.fn(),
  loginWithGoogle: vi.fn(),
  logout: vi.fn(),
  isAdmin: false,
  isPremium: false,
}

vi.mock('@/lib/auth', () => ({
  useAuth: () => mockAuthValue,
}))

function TestWrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      {children}
    </QueryClientProvider>
  )
}

function renderLayout(user?: typeof mockAuthValue.user) {
  mockAuthValue.user = user ?? null
  mockAuthValue.isPremium = user?.role === 'premium' || user?.role === 'admin'
  mockAuthValue.isAdmin = user?.role === 'admin'
  return render(
    <TestWrapper>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<div>Home</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </TestWrapper>,
  )
}

describe('Layout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders title and primary navigation', () => {
    renderLayout({ id: 1, username: 'tester', email: 't@t.com', role: 'admin' })
    expect(screen.getByText('PokeGrails')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Cards' })).toBeInTheDocument()
  })

  it('renders premium tabs as links for premium users', () => {
    renderLayout({ id: 1, username: 'pro', email: 'p@p.com', role: 'premium' })
    expect(screen.getByRole('link', { name: 'Analytics' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Watchlist' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Track Record' })).toBeInTheDocument()
  })

  it('renders premium tabs as buttons for free users', () => {
    renderLayout({ id: 1, username: 'free', email: 'f@f.com', role: 'free' })
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Analytics' })).not.toBeInTheDocument()
    const analyticsBtn = screen.getByRole('button', { name: /Analytics/i })
    expect(analyticsBtn).toBeInTheDocument()
  })

  it('shows upgrade popup when free user clicks a locked tab', () => {
    renderLayout({ id: 1, username: 'free', email: 'f@f.com', role: 'free' })
    const analyticsBtn = screen.getByRole('button', { name: /Analytics/i })
    fireEvent.click(analyticsBtn)
    expect(screen.getByText('Premium Feature')).toBeInTheDocument()
    expect(screen.getByText(/Upgrade for full access/)).toBeInTheDocument()
  })

  it('shows free tier chip next to username for free users', () => {
    renderLayout({ id: 1, username: 'free', email: 'f@f.com', role: 'free' })
    expect(screen.getByText(/Free · 3 sets/)).toBeInTheDocument()
  })
})
