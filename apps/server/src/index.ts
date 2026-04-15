import { config } from './config.js'
import { getDb } from './db/connection.js'
import { createApp } from './app.js'
import { configureWebPush } from './services/push.js'
import { fullRefresh, startCronJobs, setRefreshing } from './services/cron.js'
import { seedUpcomingSets } from './services/upcoming.js'
import { seedMissingPriceHistory } from './services/priceHistory.js'

const db = getDb()
configureWebPush()
seedUpcomingSets(db)
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
app.listen(config.port, () => {
  console.log(`PokéEdge API http://127.0.0.1:${config.port}`)
})
