import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { config } from './config.js'
import { getDb } from './db/connection.js'
import { createApp } from './app.js'
import { configureWebPush } from './services/push.js'
import { fullRefresh, startCronJobs, setRefreshing, hydrateFromDb } from './services/cron.js'
import { seedUpcomingSets } from './services/upcoming.js'
import { seedMissingPriceHistory } from './services/priceHistory.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const db = getDb()
configureWebPush()
seedUpcomingSets(db)
hydrateFromDb(db)
startCronJobs(db)

setImmediate(async () => {
  setRefreshing(true)
  try {
    await fullRefresh(db)
  } catch (e) {
    console.error('Initial ingest failed', e)
  } finally {
    setRefreshing(false)
  }
  seedMissingPriceHistory(db)
})

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
