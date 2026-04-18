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
import { LoginPage } from '@/pages/Login'
import { RegisterPage } from '@/pages/Register'
import { PrivacyPage } from '@/pages/Privacy'
import { TermsPage } from '@/pages/Terms'
import { ProtectedRoute } from '@/components/ProtectedRoute'
import { RequireAuth } from '@/components/RequireAuth'
import { CookieConsent } from '@/components/CookieConsent'
import { AuthProvider } from '@/lib/auth'

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* Public routes */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/terms" element={<TermsPage />} />

          {/* Authenticated routes */}
          <Route element={<RequireAuth />}>
            <Route element={<Layout />}>
              <Route index element={<Dashboard />} />
              <Route path="sets" element={<SetsPage />} />
              <Route path="cards" element={<Cards />} />
              <Route path="analytics" element={<ProtectedRoute requiredRole="premium"><AnalyticsPage /></ProtectedRoute>} />
              <Route path="watchlist" element={<ProtectedRoute requiredRole="premium"><WatchlistPage /></ProtectedRoute>} />
              <Route path="signals" element={<ProtectedRoute requiredRole="premium"><BuySignals /></ProtectedRoute>} />
              <Route path="alerts" element={<ProtectedRoute requiredRole="premium"><AlertsPage /></ProtectedRoute>} />
              <Route path="track-record" element={<ProtectedRoute requiredRole="premium"><TrackRecordPage /></ProtectedRoute>} />
              <Route path="card-show" element={<ProtectedRoute requiredRole="premium"><CardShowPage /></ProtectedRoute>} />
            </Route>
          </Route>
        </Routes>
        <CookieConsent />
      </AuthProvider>
    </BrowserRouter>
  )
}
