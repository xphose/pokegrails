import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function runMigrations(db: Database.Database) {
  const dir = path.join(__dirname, 'migrations')
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8')
    db.exec(sql)
  }
  // Safe column additions for databases created before these columns existed
  const safeAdd = (table: string, col: string, type: string) => {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`)
    } catch {
      /* column already exists */
    }
  }
  safeAdd('cards', 'future_value_12m', 'REAL')
  safeAdd('cards', 'annual_growth_rate', 'REAL')
  safeAdd('cards', 'pricecharting_id', 'TEXT')
  safeAdd('price_history', 'pricecharting_median', 'REAL')
  safeAdd('sets', 'box_price_verified', 'INTEGER DEFAULT 0')
  safeAdd('sets', 'product_type', "TEXT DEFAULT 'bb'")
  safeAdd('sets', 'product_packs', 'INTEGER DEFAULT 36')
  safeAdd('sets', 'price_sources', 'INTEGER DEFAULT 0')
  safeAdd('sets', 'price_confidence', "TEXT DEFAULT 'low'")
  safeAdd('cards', 'pc_price_raw', 'REAL')
  safeAdd('cards', 'pc_price_grade7', 'REAL')
  safeAdd('cards', 'pc_price_grade8', 'REAL')
  safeAdd('cards', 'pc_price_grade9', 'REAL')
  safeAdd('cards', 'pc_price_grade95', 'REAL')
  safeAdd('cards', 'pc_price_psa10', 'REAL')
  safeAdd('cards', 'pc_price_bgs10', 'REAL')

  db.exec(`CREATE TABLE IF NOT EXISTS sealed_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    set_id TEXT NOT NULL,
    product_type TEXT NOT NULL,
    source TEXT NOT NULL,
    price REAL NOT NULL,
    packs INTEGER NOT NULL,
    fetched_at TEXT NOT NULL
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sealed_set_type ON sealed_products(set_id, product_type, fetched_at)`)

  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'free' CHECK(role IN ('free', 'premium', 'admin')),
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login TEXT
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`)

  db.exec(`CREATE TABLE IF NOT EXISTS refresh_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash)`)

  safeAdd('users', 'display_name', 'TEXT')
  safeAdd('users', 'oauth_provider', 'TEXT')
  safeAdd('users', 'oauth_id', 'TEXT')

  db.exec(`CREATE TABLE IF NOT EXISTS prediction_snapshots (
    card_id TEXT NOT NULL,
    snapshot_date TEXT NOT NULL,
    predicted_price REAL,
    market_price REAL,
    valuation_flag TEXT,
    desirability_score REAL,
    pull_cost_score REAL,
    future_value_12m REAL,
    annual_growth_rate REAL,
    PRIMARY KEY (card_id, snapshot_date)
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_date ON prediction_snapshots(snapshot_date)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_flag ON prediction_snapshots(valuation_flag)`)
}
