import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@/lib/auth'

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: Record<string, unknown>) => void
          renderButton: (el: HTMLElement, config: Record<string, unknown>) => void
        }
      }
    }
  }
}

interface Props {
  onSuccess?: () => void
  onError?: (msg: string) => void
}

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined

export function GoogleSignInButton({ onSuccess, onError }: Props) {
  const { loginWithGoogle } = useAuth()
  const containerRef = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return

    const existing = document.querySelector('script[src*="accounts.google.com/gsi/client"]')
    if (existing) {
      if (window.google?.accounts) setReady(true)
      else existing.addEventListener('load', () => setReady(true))
      return
    }

    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.onload = () => setReady(true)
    document.head.appendChild(script)
  }, [])

  useEffect(() => {
    if (!ready || !containerRef.current || !GOOGLE_CLIENT_ID) return

    window.google!.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: async (response: { credential?: string }) => {
        if (!response.credential) {
          onError?.('No credential received from Google')
          return
        }
        setSubmitting(true)
        try {
          await loginWithGoogle(response.credential)
          onSuccess?.()
        } catch (err) {
          onError?.(err instanceof Error ? err.message : 'Google login failed')
        } finally {
          setSubmitting(false)
        }
      },
    })

    window.google!.accounts.id.renderButton(containerRef.current, {
      type: 'standard',
      theme: 'outline',
      size: 'large',
      width: containerRef.current.offsetWidth,
      text: 'continue_with',
    })
  }, [ready, loginWithGoogle, onSuccess, onError])

  if (!GOOGLE_CLIENT_ID) return null

  return (
    <div className="relative">
      <div ref={containerRef} className="flex justify-center [&>div]:!w-full" />
      {submitting && (
        <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-background/80">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      )}
    </div>
  )
}
