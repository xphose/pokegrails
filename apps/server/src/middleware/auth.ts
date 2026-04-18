import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import type { Database } from 'better-sqlite3'
import { config } from '../config.js'

export type UserRole = 'free' | 'premium' | 'admin'

export interface JwtPayload {
  userId: number
  username: string
  role: UserRole
}

const FREE_SET_LIMIT = 3

let freeSetIdsCache: string[] | null = null
let freeSetIdsCacheTime = 0
const CACHE_TTL = 60_000

export function getFreeSetIds(db: Database): string[] {
  const now = Date.now()
  if (freeSetIdsCache && now - freeSetIdsCacheTime < CACHE_TTL) return freeSetIdsCache
  const rows = db.prepare(
    `SELECT id FROM sets
     WHERE release_date IS NOT NULL AND trim(release_date) != ''
     ORDER BY release_date DESC
     LIMIT ?`
  ).all(FREE_SET_LIMIT) as { id: string }[]
  freeSetIdsCache = rows.map(r => r.id)
  freeSetIdsCacheTime = now
  return freeSetIdsCache
}

/**
 * Drop the in-memory free-set cache. Only useful in tests that seed sets
 * across multiple describes — production's 60s TTL is fine.
 */
export function resetFreeSetIdsCacheForTests(): void {
  freeSetIdsCache = null
  freeSetIdsCacheTime = 0
}

export function isFreeUser(req: Request): boolean {
  return !req.user || req.user.role === 'free'
}

export function freeSetFilter(db: Database, req: Request): { sql: string; ids: string[] } | null {
  if (!isFreeUser(req)) return null
  const ids = getFreeSetIds(db)
  if (!ids.length) return null
  const placeholders = ids.map(() => '?').join(', ')
  return { sql: ` AND set_id IN (${placeholders})`, ids }
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload
    }
  }
}

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }
  const token = header.slice(7)
  try {
    const payload = jwt.verify(token, config.jwtSecret) as JwtPayload
    req.user = payload
    next()
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
}

/**
 * Auth-optional middleware used on endpoints that behave differently for
 * anonymous vs. authenticated users (free-tier set filters, etc.).
 *
 * Critical: if a Bearer token IS present but invalid/expired, we must
 * return 401 so the client knows to refresh the access token. The previous
 * "silently continue as anonymous" behaviour caused a very confusing bug
 * where a 15-minute-old session would silently start returning free-tier
 * results — search "mew" shows 2 cards instead of 20 — with no indication
 * to the client that re-auth was needed. The only time the user knew was
 * when they clicked "Reload Data" (which hits an admin-only route, which
 * returns a real 401, which triggers the client's refresh flow).
 *
 * If no token is present at all, we pass through as anonymous. That's the
 * genuinely "optional" path.
 */
export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    next()
    return
  }
  try {
    req.user = jwt.verify(header.slice(7), config.jwtSecret) as JwtPayload
    next()
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Insufficient permissions' })
      return
    }
    next()
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }
  if (req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' })
    return
  }
  next()
}
