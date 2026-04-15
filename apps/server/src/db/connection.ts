import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { config } from '../config.js'
import { runMigrations } from './migrate.js'

let dbInstance: Database.Database | null = null

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance
  const dir = path.dirname(config.databasePath)
  fs.mkdirSync(dir, { recursive: true })
  const db = new Database(config.databasePath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 10000')
  runMigrations(db)
  dbInstance = db
  return db
}
