import { Router, Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import crypto from 'node:crypto'
import type { StringValue } from 'ms'
import type { Database } from 'better-sqlite3'
import { config } from '../config.js'
import { authenticate, type JwtPayload } from '../middleware/auth.js'

const SALT_ROUNDS = 12
const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function generateTokens(payload: JwtPayload) {
  const accessToken = jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn as StringValue })
  const refreshToken = jwt.sign({ userId: payload.userId, type: 'refresh' }, config.jwtRefreshSecret, { expiresIn: config.jwtRefreshExpiresIn as StringValue })
  return { accessToken, refreshToken }
}

function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export function authRoutes(db: Database): Router {
  const router = Router()

  router.post('/register', async (req: Request, res: Response) => {
    try {
      const { username, email, password } = req.body as { username?: string; email?: string; password?: string }
      if (!username || !email || !password) {
        res.status(400).json({ error: 'username, email, and password are required' })
        return
      }
      if (!USERNAME_RE.test(username)) {
        res.status(400).json({ error: 'Username must be 3-30 alphanumeric characters or underscores' })
        return
      }
      if (!EMAIL_RE.test(email)) {
        res.status(400).json({ error: 'Invalid email format' })
        return
      }
      if (password.length < 8) {
        res.status(400).json({ error: 'Password must be at least 8 characters' })
        return
      }

      const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username.toLowerCase(), email.toLowerCase()) as { id: number } | undefined
      if (existing) {
        res.status(409).json({ error: 'Username or email already taken' })
        return
      }

      const passwordHash = await bcrypt.hash(password, SALT_ROUNDS)
      const isFirstUser = !(db.prepare('SELECT 1 FROM users LIMIT 1').get())
      const role = isFirstUser ? 'admin' : 'free'

      const result = db.prepare(
        'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)'
      ).run(username, email.toLowerCase(), passwordHash, role)

      const userId = result.lastInsertRowid as number
      const payload: JwtPayload = { userId: Number(userId), username, role: role as any }
      const { accessToken, refreshToken } = generateTokens(payload)

      const tokenHash = hashRefreshToken(refreshToken)
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      db.prepare('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(userId, tokenHash, expiresAt)

      res.status(201).json({
        user: { id: Number(userId), username, email: email.toLowerCase(), role },
        accessToken,
        refreshToken,
      })
    } catch (e) {
      console.error('[auth] Register error:', e)
      res.status(500).json({ error: 'Registration failed' })
    }
  })

  router.post('/login', async (req: Request, res: Response) => {
    try {
      const { login, password } = req.body as { login?: string; password?: string }
      if (!login || !password) {
        res.status(400).json({ error: 'login and password are required' })
        return
      }

      const user = db.prepare(
        'SELECT id, username, email, password_hash, role FROM users WHERE username = ? OR email = ?'
      ).get(login.toLowerCase(), login.toLowerCase()) as { id: number; username: string; email: string; password_hash: string; role: string } | undefined

      if (!user) {
        res.status(401).json({ error: 'Invalid credentials' })
        return
      }

      const valid = await bcrypt.compare(password, user.password_hash)
      if (!valid) {
        res.status(401).json({ error: 'Invalid credentials' })
        return
      }

      db.prepare('UPDATE users SET last_login = datetime(\'now\') WHERE id = ?').run(user.id)

      const payload: JwtPayload = { userId: user.id, username: user.username, role: user.role as any }
      const { accessToken, refreshToken } = generateTokens(payload)

      const tokenHash = hashRefreshToken(refreshToken)
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(user.id)
      db.prepare('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(user.id, tokenHash, expiresAt)

      res.json({
        user: { id: user.id, username: user.username, email: user.email, role: user.role },
        accessToken,
        refreshToken,
      })
    } catch (e) {
      console.error('[auth] Login error:', e)
      res.status(500).json({ error: 'Login failed' })
    }
  })

  router.post('/refresh', (req: Request, res: Response) => {
    try {
      const { refreshToken: token } = req.body as { refreshToken?: string }
      if (!token) {
        res.status(400).json({ error: 'refreshToken is required' })
        return
      }

      let decoded: { userId: number; type: string }
      try {
        decoded = jwt.verify(token, config.jwtRefreshSecret) as any
      } catch {
        res.status(401).json({ error: 'Invalid or expired refresh token' })
        return
      }

      if (decoded.type !== 'refresh') {
        res.status(401).json({ error: 'Invalid token type' })
        return
      }

      const tokenHash = hashRefreshToken(token)
      const stored = db.prepare(
        'SELECT rt.id, rt.user_id FROM refresh_tokens rt WHERE rt.token_hash = ? AND rt.expires_at > datetime(\'now\')'
      ).get(tokenHash) as { id: number; user_id: number } | undefined

      if (!stored) {
        res.status(401).json({ error: 'Refresh token not found or expired' })
        return
      }

      const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(stored.user_id) as { id: number; username: string; role: string } | undefined
      if (!user) {
        res.status(401).json({ error: 'User not found' })
        return
      }

      const payload: JwtPayload = { userId: user.id, username: user.username, role: user.role as any }
      const tokens = generateTokens(payload)

      db.prepare('DELETE FROM refresh_tokens WHERE id = ?').run(stored.id)
      const newHash = hashRefreshToken(tokens.refreshToken)
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      db.prepare('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(user.id, newHash, expiresAt)

      res.json({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken })
    } catch (e) {
      console.error('[auth] Refresh error:', e)
      res.status(500).json({ error: 'Token refresh failed' })
    }
  })

  router.post('/google', async (req: Request, res: Response) => {
    try {
      const { credential } = req.body as { credential?: string }
      if (!credential) {
        res.status(400).json({ error: 'credential is required' })
        return
      }
      if (!config.googleClientId) {
        res.status(503).json({ error: 'Google login is not configured' })
        return
      }

      const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`)
      if (!verifyRes.ok) {
        res.status(401).json({ error: 'Invalid Google credential' })
        return
      }
      const gInfo = await verifyRes.json() as { sub?: string; email?: string; name?: string; aud?: string }
      if (gInfo.aud !== config.googleClientId) {
        res.status(401).json({ error: 'Token audience mismatch' })
        return
      }
      if (!gInfo.email || !gInfo.sub) {
        res.status(401).json({ error: 'Invalid token payload' })
        return
      }

      const email = gInfo.email.toLowerCase()
      const googleId = gInfo.sub
      const displayName = gInfo.name || email.split('@')[0]

      let user = db.prepare('SELECT id, username, email, role FROM users WHERE email = ?').get(email) as
        | { id: number; username: string; email: string; role: string } | undefined

      if (!user) {
        const username = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 30) || `user_${googleId.slice(-6)}`
        let finalUsername = username
        let suffix = 1
        while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(finalUsername.toLowerCase())) {
          finalUsername = `${username.slice(0, 26)}_${suffix++}`
        }

        const isFirstUser = !(db.prepare('SELECT 1 FROM users LIMIT 1').get())
        const role = isFirstUser ? 'admin' : 'free'
        const dummyHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), SALT_ROUNDS)

        const result = db.prepare(
          'INSERT INTO users (username, email, password_hash, role, display_name, oauth_provider, oauth_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(finalUsername, email, dummyHash, role, displayName, 'google', googleId)

        user = { id: Number(result.lastInsertRowid), username: finalUsername, email, role }
      } else {
        db.prepare('UPDATE users SET oauth_provider = ?, oauth_id = ?, last_login = datetime(\'now\') WHERE id = ?')
          .run('google', googleId, user.id)
      }

      const payload: JwtPayload = { userId: user.id, username: user.username, role: user.role as any }
      const { accessToken, refreshToken } = generateTokens(payload)

      const tokenHash = hashRefreshToken(refreshToken)
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(user.id)
      db.prepare('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(user.id, tokenHash, expiresAt)

      res.json({
        user: { id: user.id, username: user.username, email: user.email, role: user.role },
        accessToken,
        refreshToken,
      })
    } catch (e) {
      console.error('[auth] Google login error:', e)
      res.status(500).json({ error: 'Google login failed' })
    }
  })

  router.get('/me', authenticate, (req: Request, res: Response) => {
    const user = db.prepare('SELECT id, username, email, role, display_name, created_at, last_login FROM users WHERE id = ?').get(req.user!.userId)
    if (!user) {
      res.status(404).json({ error: 'User not found' })
      return
    }
    res.json({ user })
  })

  router.post('/logout', authenticate, (req: Request, res: Response) => {
    db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(req.user!.userId)
    res.json({ ok: true })
  })

  return router
}
