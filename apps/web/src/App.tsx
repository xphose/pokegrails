import { lazy, Suspense } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Layout } from '@/components/Layout'

const Dashboard = lazy(() => import('@/pages/Dashboard').then(m => ({ default: m.Dashboard })))
const Cards = lazy(() => import('@/pages/Cards').then(m => ({ default: m.Cards })))
const SetsPage = lazy(() => import('@/pages/Sets').then(m => ({ default: m.SetsPage })))
const AnalyticsPage = lazy(() => import('@/pages/Analytics').then(m => ({ default: m.AnalyticsPage })))
const WatchlistPage = lazy(() => import('@/pages/Watchlist').then(m => ({ default: m.WatchlistPage })))
const BuySignals = lazy(() => import('@/pages/BuySignals').then(m => ({ default: m.BuySignals })))
const CardShowPage = lazy(() => import('@/pages/CardShow').then(m => ({ default: m.CardShowPage })))
const AlertsPage = lazy(() => import('@/pages/Alerts').then(m => ({ default: m.AlertsPage })))
const TrackRecordPage = lazy(() => import('@/pages/TrackRecord').then(m => ({ default: m.TrackRecordPage })))

function PageFallback() {
  return (
    <div className="flex flex-1 items-center justify-center py-20">
      <span className="inline-block size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Suspense fallback={<PageFallback />}><Dashboard /></Suspense>} />
          <Route path="sets" element={<Suspense fallback={<PageFallback />}><SetsPage /></Suspense>} />
          <Route path="cards" element={<Suspense fallback={<PageFallback />}><Cards /></Suspense>} />
          <Route path="analytics" element={<Suspense fallback={<PageFallback />}><AnalyticsPage /></Suspense>} />
          <Route path="watchlist" element={<Suspense fallback={<PageFallback />}><WatchlistPage /></Suspense>} />
          <Route path="signals" element={<Suspense fallback={<PageFallback />}><BuySignals /></Suspense>} />
          <Route path="alerts" element={<Suspense fallback={<PageFallback />}><AlertsPage /></Suspense>} />
          <Route path="track-record" element={<Suspense fallback={<PageFallback />}><TrackRecordPage /></Suspense>} />
          <Route path="card-show" element={<Suspense fallback={<PageFallback />}><CardShowPage /></Suspense>} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
