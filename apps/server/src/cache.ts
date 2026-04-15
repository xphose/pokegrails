/**
 * Tiny in-memory TTL cache for read-heavy JSON API responses.
 * Invalidated after full data refresh so UI never stays stale for long.
 */
import type { Request, Response } from 'express'

type Entry = { value: string; expiresAt: number }

const store = new Map<string, Entry>()

export function cacheGet(key: string): string | null {
  const e = store.get(key)
  if (!e) return null
  if (Date.now() > e.expiresAt) {
    store.delete(key)
    return null
  }
  return e.value
}

export function cacheSet(key: string, value: unknown, ttlMs: number): void {
  store.set(key, {
    value: typeof value === 'string' ? value : JSON.stringify(value),
    expiresAt: Date.now() + ttlMs,
  })
}

export function cacheInvalidateAll(): void {
  store.clear()
}

/**
 * Express handler that caches JSON responses by request path.
 * Eliminates the repeated get-check-compute-set pattern across routes.
 */
export function cachedJson(
  ttlMs: number,
  compute: (req: Request) => unknown,
): (req: Request, res: Response) => void {
  return (req, res) => {
    const key = `GET:${req.path}`
    const hit = cacheGet(key)
    if (hit) return res.type('json').send(hit)
    const body = compute(req)
    cacheSet(key, body, ttlMs)
    res.json(body)
  }
}
