import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
for (const p of [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '..', '..', '.env'),
  path.join(__dirname, '..', '..', '.env'),
]) {
  if (fs.existsSync(p)) dotenv.config({ path: p })
}

export const config = {
  port: Number(process.env.PORT) || 3001,
  databasePath: process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'pokegrails.sqlite'),
  pokemonTcgApiKey: process.env.POKEMONTCG_API_KEY || '',
  ebayClientId: process.env.EBAY_CLIENT_ID || '',
  ebayClientSecret: process.env.EBAY_CLIENT_SECRET || '',
  ebayEnvironment: (process.env.EBAY_ENVIRONMENT || 'production') as 'sandbox' | 'production',
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:localhost@pokegrails.com',
  pricechartingApiKey: process.env.PRICECHARTING_API_KEY || '',
  publicAppUrl: process.env.PUBLIC_APP_URL || 'http://localhost:5173',
  corsOrigins: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim())
    : [process.env.PUBLIC_APP_URL || 'http://localhost:5173', 'http://localhost:5173', 'http://localhost:3001'],
  jwtSecret: process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-in-production',
  jwtExpiresIn: '15m',
  jwtRefreshExpiresIn: '7d',
  nodeEnv: process.env.NODE_ENV || 'development',
  pokemonTcgBase: 'https://api.pokemontcg.io/v2',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  stripePriceIdMonthly: process.env.STRIPE_PRICE_ID_MONTHLY || '',
  stripePriceIdYearly: process.env.STRIPE_PRICE_ID_YEARLY || '',
}
