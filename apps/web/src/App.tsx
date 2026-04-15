import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Layout } from '@/components/Layout'
import { Dashboard } from '@/pages/Dashboard'
import { Cards } from '@/pages/Cards'
import { SetsPage } from '@/pages/Sets'
import { WatchlistPage } from '@/pages/Watchlist'
import { BuySignals } from '@/pages/BuySignals'
import { CardShowPage } from '@/pages/CardShow'
import { AlertsPage } from '@/pages/Alerts'
import { TrackRecordPage } from '@/pages/TrackRecord'
import { AnalyticsPage } from '@/pages/Analytics'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="sets" element={<SetsPage />} />
          <Route path="cards" element={<Cards />} />
          <Route path="analytics" element={<AnalyticsPage />} />
          <Route path="watchlist" element={<WatchlistPage />} />
          <Route path="signals" element={<BuySignals />} />
          <Route path="alerts" element={<AlertsPage />} />
          <Route path="track-record" element={<TrackRecordPage />} />
          <Route path="card-show" element={<CardShowPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
