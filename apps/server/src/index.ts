import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { config } from './config.js'
import { getDb } from './db/connection.js'
import { createApp } from './app.js'
import { configureWebPush } from './services/push.js'
import { dataRefresh, startCronJobs, setRefreshing, hydrateFromDb } from './services/cron.js'
import { seedUpcomingSets } from './services/upcoming.js'
import { seedMissingPriceHistory } from './services/priceHistory.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const db = getDb()
configureWebPush()
seedUpcomingSets(db)

// Every worker loads its own in-memory analytics cache from SQLite — cheap,
// and required so any worker can answer requests instantly on cold start.
hydrateFromDb(db)

// Crons, the initial ingest, and the Reddit poller MUST run on exactly one
// process, otherwise we'd double-write to external APIs, double-notify users,
// and race on SQLite writes. In PM2 cluster mode each worker gets a unique
// NODE_APP_INSTANCE ('0', '1', …); in fork mode the env var is undefined.
// We elect worker 0 (or the single fork-mode process) as the "primary".
const workerId = process.env.NODE_APP_INSTANCE
const isPrimary = workerId === undefined || workerId === '0'

if (isPrimary) {
  console.log(`[primary] worker=${workerId ?? 'fork'} — enabling cron jobs`)
  startCronJobs(db)

  // Only run the full ingest on a truly cold DB. Otherwise PM2's
  // max_memory_restart on the primary worker turns into a restart loop: ingest
  // grows memory past the cap, PM2 kills the worker, a new worker starts and
  // kicks off another ingest, and so on. The 4-hour cron still refreshes
  // prices, so on warm DBs we let that handle it.
  const cardCount = (db.prepare('SELECT COUNT(*) AS c FROM cards').get() as { c: number } | undefined)?.c ?? 0
  if (cardCount === 0) {
    console.log('[primary] cold DB detected — running initial ingest')
    setImmediate(async () => {
      setRefreshing(true)
      try {
        await dataRefresh(db)
      } catch (e) {
        console.error('Initial ingest failed', e)
      } finally {
        setRefreshing(false)
      }
      seedMissingPriceHistory(db)
    })
  } else {
    console.log(`[primary] warm DB (${cardCount} cards) — skipping initial ingest; cron will refresh`)
  }

  // One-shot PriceCharting backfill + scrub when the DB has never been
  // matched. This is the only path that populates `pc_price_*` columns and
  // `card_grade_history`; without it the "Grade" toggle in the UI is empty.
  // Guarded by API-key presence + a zero-match check, so it runs exactly
  // once per install and is a no-op otherwise.
  if (config.pricechartingApiKey) {
    const pcMatched = (
      db.prepare('SELECT COUNT(*) AS c FROM cards WHERE pricecharting_id IS NOT NULL').get() as
        | { c: number }
        | undefined
    )?.c ?? 0
    if (pcMatched === 0) {
      console.log('[primary] no PriceCharting matches found — scheduling background backfill + scrub')
      setImmediate(async () => {
        try {
          const { runPricechartingBackfill } = await import('./services/pricechartingBackfill.js')
          const { scrubPriceHistory } = await import('./services/priceHistoryScrub.js')
          const stats = await runPricechartingBackfill(db, { force: false })
          console.log('[primary] initial pc-backfill complete:', stats)
          const scrubResult = scrubPriceHistory(db)
          console.log('[primary] post-backfill scrub complete:', scrubResult)
        } catch (e) {
          console.error('[primary] initial pc-backfill failed:', e)
        }
      })
    }
  }
} else {
  console.log(`[worker ${workerId}] HTTP-only — cron jobs + ingest handled by worker 0`)
}

const app = createApp(db)

if (config.nodeEnv === 'production') {
  const webDist = path.resolve(__dirname, '..', '..', '..', 'apps', 'web', 'dist')
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist, { maxAge: '1d', etag: true }))
    app.get('{*path}', (req, res, next) => {
      if (req.path.startsWith('/api')) return next()
      res.sendFile(path.join(webDist, 'index.html'))
    })
    console.log(`Serving static frontend from ${webDist}`)
  }
}

app.listen(config.port, () => {
  console.log(`PokeGrails API http://127.0.0.1:${config.port}`)
})
