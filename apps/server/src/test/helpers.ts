import Database from 'better-sqlite3'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../db/migrate.js'
import { config } from '../config.js'

export function openMemoryDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = MEMORY')
  runMigrations(db)
  return db
}

export function adminToken(): string {
  return jwt.sign({ userId: 1, username: 'testadmin', role: 'admin' }, config.jwtSecret, { expiresIn: '1h' })
}

export function premiumToken(): string {
  return jwt.sign({ userId: 2, username: 'testpremium', role: 'premium' }, config.jwtSecret, { expiresIn: '1h' })
}

export function freeToken(): string {
  return jwt.sign({ userId: 3, username: 'testfree', role: 'free' }, config.jwtSecret, { expiresIn: '1h' })
}

export function seedMinimalCard(db: Database.Database) {
  db.prepare(
    `INSERT INTO sets (id, name, release_date, total_cards, last_updated) VALUES (?, ?, ?, ?, datetime('now'))`,
  ).run('test-set', 'Test Set', '2024-01-01', 1)
  db.prepare(
    `INSERT INTO cards (
      id, name, set_id, rarity, image_url, character_name, card_type,
      market_price, pull_cost_score, desirability_score, predicted_price, valuation_flag, last_updated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    'test-card-1',
    'Pikachu',
    'test-set',
    'Ultra Rare',
    'https://example.com/card.png',
    'Pikachu',
    'Ultra Rare',
    10,
    5,
    6,
    12,
    '🟡 FAIRLY VALUED',
  )
}
