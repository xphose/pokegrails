import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function seedUpcomingSets(db: Database.Database) {
  const seedPath = path.join(__dirname, '../data/upcoming-sets-seed.json')
  if (!fs.existsSync(seedPath)) return
  const raw = fs.readFileSync(seedPath, 'utf8')
  const rows = JSON.parse(raw) as { id: string; name: string; release_date: string; source: string }[]
  const stmt = db.prepare(
    `INSERT INTO upcoming_sets (id, name, release_date, source) VALUES (@id, @name, @release_date, @source)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, release_date = excluded.release_date, source = excluded.source`,
  )
  for (const r of rows) stmt.run(r)
}

/** Heuristic top-5 prediction for unreleased sets (uses character + rarity from announced list when ingested). */
export function predictChaseForUpcoming(db: Database.Database, setId: string) {
  const cards = db
    .prepare(
      `SELECT id, name, desirability_score, pull_cost_score FROM cards WHERE set_id = ? ORDER BY desirability_score DESC LIMIT 5`,
    )
    .all(setId) as { id: string; name: string; desirability_score: number | null; pull_cost_score: number | null }[]

  db.prepare(`UPDATE upcoming_sets SET predicted_top_json = ? WHERE id = ?`).run(JSON.stringify(cards), setId)
}
