import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function seedPullRates(db: Database.Database) {
  const raw = fs.readFileSync(path.join(__dirname, '../data/pull-rate-seed.json'), 'utf8')
  const data = JSON.parse(raw) as Record<
    string,
    Record<string, { denominator: number; cards_in_slot: number }>
  >
  const template = data.sv10
  if (!template) throw new Error('pull-rate-seed.json must define sv10 as fallback tiers')
  const dbSetIds = (db.prepare(`SELECT id FROM sets`).all() as { id: string }[]).map(r => r.id)
  for (const id of dbSetIds) {
    if (!data[id]) {
      data[id] = JSON.parse(JSON.stringify(template)) as (typeof data)[string]
    }
  }
  const stmt = db.prepare(
    `INSERT INTO pull_rates (set_id, rarity_tier, pull_rate_denominator, cards_in_rarity_slot)
     VALUES (@set_id, @rarity_tier, @pull_rate_denominator, @cards_in_rarity_slot)
     ON CONFLICT(set_id, rarity_tier) DO UPDATE SET
       pull_rate_denominator = excluded.pull_rate_denominator,
       cards_in_rarity_slot = excluded.cards_in_rarity_slot`,
  )
  const tx = db.transaction(() => {
    for (const [setId, tiers] of Object.entries(data)) {
      for (const [tier, v] of Object.entries(tiers)) {
        stmt.run({
          set_id: setId,
          rarity_tier: tier,
          pull_rate_denominator: v.denominator,
          cards_in_rarity_slot: v.cards_in_slot,
        })
      }
    }
  })
  tx()
}

export function getPullCostRaw(
  db: Database.Database,
  setId: string,
  rarityTier: string,
): number | null {
  const row = db
    .prepare(
      `SELECT pull_rate_denominator, cards_in_rarity_slot FROM pull_rates
       WHERE set_id = ? AND rarity_tier = ?`,
    )
    .get(setId, rarityTier) as
    | { pull_rate_denominator: number; cards_in_rarity_slot: number }
    | undefined
  if (!row) {
    const fallback = db
      .prepare(
        `SELECT pull_rate_denominator, cards_in_rarity_slot FROM pull_rates
         WHERE set_id = ? AND rarity_tier = 'Ultra Rare'`,
      )
      .get(setId) as
      | { pull_rate_denominator: number; cards_in_rarity_slot: number }
      | undefined
    if (!fallback) return null
    return fallback.pull_rate_denominator * fallback.cards_in_rarity_slot
  }
  return row.pull_rate_denominator * row.cards_in_rarity_slot
}
