import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import App from './App.tsx'
import { TooltipProvider } from '@/components/ui/tooltip'
import { queryClient } from '@/lib/query-client'
import { initThemeMode } from '@/lib/theme'
import { HelpCenterProvider } from '@/components/help-center'

initThemeMode()

// AuthProvider lives inside App.tsx (inside BrowserRouter) so it can use
// useNavigate / useLocation for session-expiry redirects.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <HelpCenterProvider>
        <TooltipProvider delay={250} closeDelay={400}>
          <App />
        </TooltipProvider>
      </HelpCenterProvider>
    </QueryClientProvider>
  </StrictMode>,
)
