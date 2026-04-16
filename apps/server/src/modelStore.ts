import type Database from 'better-sqlite3'

export function saveModelResult(db: Database.Database, modelId: string, result: unknown): void {
  db.prepare(
    `INSERT OR REPLACE INTO model_results (model_id, result_json, computed_at) VALUES (?, ?, ?)`,
  ).run(modelId, JSON.stringify(result), new Date().toISOString())
}

export function loadModelResult(db: Database.Database, modelId: string): unknown | null {
  const row = db.prepare(`SELECT result_json FROM model_results WHERE model_id = ?`)
    .get(modelId) as { result_json: string } | undefined
  if (!row) return null
  try { return JSON.parse(row.result_json) } catch { return null }
}
