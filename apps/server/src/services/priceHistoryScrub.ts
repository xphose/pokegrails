import type Database from 'better-sqlite3'

/**
 * Multi-signal `price_history` scrub.
 *
 * The ingest gate in `pokemontcg.ts` prevents new bad ticks, but we have
 * historical contamination that predates it (1,997 cards on prod had ≥2x
 * spikes above their current market when this was written). Rather than a
 * single-threshold delete, this scrub uses three *independent* signals and
 * a conservative "how many fired" decision policy, which is the standard
 * robust-statistics approach to automated data cleaning:
 *
 *   Signal A — Cross-source disagreement.
 *     If the same (card, day) has a `pricecharting_median` value, and
 *     `tcgplayer_market` > 2.5× that value, the TCGPlayer row disagrees
 *     with the authoritative PC number by a margin that isn't explainable
 *     by intra-day arbitrage.
 *
 *   Signal B — Robust-statistics outlier (median + MAD).
 *     Build a 14-day rolling window around the row's date (7 days before
 *     and 7 after when available). If `tcgplayer_market` is more than 5
 *     MADs from the window median, it's an outlier by a standard rule that
 *     handles fat-tailed distributions better than z-scores. We use MAD
 *     because card prices have heavy tails and real large moves shouldn't
 *     be flagged just because they're unusual for that card.
 *
 *   Signal C — Spike-and-revert.
 *     A genuine market move sustains. A data glitch snaps high then
 *     reverts. If the row is >2× the 3-day *prior* median AND the 3-day
 *     *following* median returns to within 20% of pre-spike levels, it's
 *     a near-certain data error.
 *
 * Decision policy per flagged row:
 *   - All three signals fire  → delete (high confidence error).
 *   - Two signals fire        → winsorize: replace value with the local
 *                                anchor (PC median when available, else
 *                                window median) and tag `source`.
 *   - One signal fires        → leave alone, but log.
 *
 * Safety net: if more than 25% of a card's history would be deleted in a
 * single pass, we skip that card entirely and log a warning. A scrub should
 * never be able to nuke a card's history; that many hits usually means our
 * anchor itself is broken (e.g. the card recently re-released and the
 * "spike" is real).
 */

export interface ScrubResult {
  cardsExamined: number
  rowsDeleted: number
  rowsWinsorized: number
  rowsFlagged: number
  cardsSkipped: number
  /** Optional card-by-card detail for the admin endpoint's JSON response. */
  details?: Array<{ cardId: string; deleted: number; winsorized: number; flagged: number; skipped: boolean }>
}

type HistoryRow = {
  rowid: number
  card_id: string
  timestamp: string
  tcgplayer_market: number | null
  pricecharting_median: number | null
  source: string | null
}

export interface ScrubOptions {
  /** Only scrub rows for a specific card (useful for the admin endpoint). */
  cardId?: string
  /** Include per-card breakdowns in the return value. */
  verbose?: boolean
  /** Override thresholds for tests. Production uses defaults. */
  crossSourceMultiplier?: number
  madMultiplier?: number
  spikeMultiplier?: number
  revertTolerance?: number
  windowDays?: number
  maxDeleteFraction?: number
}

const DEFAULTS = {
  crossSourceMultiplier: 2.5,
  madMultiplier: 5,
  spikeMultiplier: 2,
  revertTolerance: 0.2,
  windowDays: 7,
  maxDeleteFraction: 0.25,
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function mad(xs: number[], center: number): number {
  if (xs.length === 0) return 0
  return median(xs.map((v) => Math.abs(v - center)))
}

export function scrubPriceHistory(db: Database.Database, opts: ScrubOptions = {}): ScrubResult {
  const cfg = { ...DEFAULTS, ...opts }

  // `source` column is TEXT NULLable. Older rows have NULL which we treat as
  // untagged. We never touch rows tagged 'pricecharting-chart' because those
  // ARE the anchor — deleting them would be circular.
  const baseWhere = opts.cardId ? `WHERE card_id = ?` : ''
  const cards = (
    db
      .prepare(
        `SELECT card_id, COUNT(*) as total FROM price_history ${baseWhere} GROUP BY card_id`,
      )
      .all(...(opts.cardId ? [opts.cardId] : [])) as { card_id: string; total: number }[]
  )

  const result: ScrubResult = {
    cardsExamined: 0,
    rowsDeleted: 0,
    rowsWinsorized: 0,
    rowsFlagged: 0,
    cardsSkipped: 0,
    details: opts.verbose ? [] : undefined,
  }

  const rowsStmt = db.prepare(
    `SELECT rowid, card_id, timestamp, tcgplayer_market, pricecharting_median, source
     FROM price_history
     WHERE card_id = ? AND tcgplayer_market IS NOT NULL AND tcgplayer_market > 0
     ORDER BY timestamp ASC`,
  )
  const deleteStmt = db.prepare(`DELETE FROM price_history WHERE rowid = ?`)
  const winsorizeStmt = db.prepare(
    `UPDATE price_history SET tcgplayer_market = ?, source = 'scrubbed-winsorized' WHERE rowid = ?`,
  )

  const windowMs = cfg.windowDays * 86_400_000

  for (const { card_id, total } of cards) {
    const rows = rowsStmt.all(card_id) as HistoryRow[]
    if (rows.length === 0) continue
    result.cardsExamined++

    type Flag = { row: HistoryRow; signals: number; localAnchor: number }
    const flagged: Flag[] = []

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      if (row.source === 'pricecharting-chart') continue // never touch PC-sourced rows
      const value = row.tcgplayer_market!
      const ts = Date.parse(row.timestamp)
      if (!Number.isFinite(ts)) continue

      // Build a symmetric 14-day window around this row (7d before + 7d after).
      const winLow = ts - windowMs
      const winHigh = ts + windowMs
      const neighbours: number[] = []
      for (let j = 0; j < rows.length; j++) {
        if (j === i) continue
        const tj = Date.parse(rows[j].timestamp)
        if (tj >= winLow && tj <= winHigh && rows[j].tcgplayer_market && rows[j].tcgplayer_market! > 0) {
          neighbours.push(rows[j].tcgplayer_market!)
        }
      }

      let signals = 0
      let localAnchor = value

      // Signal A: cross-source disagreement.
      if (row.pricecharting_median && row.pricecharting_median > 0) {
        if (value > cfg.crossSourceMultiplier * row.pricecharting_median) {
          signals++
          localAnchor = row.pricecharting_median
        }
      }

      // Signal B: MAD outlier on the rolling window.
      if (neighbours.length >= 3) {
        const m = median(neighbours)
        const d = mad(neighbours, m)
        const scale = Math.max(d, 0.05 * m)
        if (scale > 0 && Math.abs(value - m) > cfg.madMultiplier * scale) {
          signals++
          if (localAnchor === value) localAnchor = m
        }
      }

      // Signal C: spike-and-revert.
      const prior: number[] = []
      const next: number[] = []
      for (let j = 0; j < rows.length; j++) {
        if (j === i) continue
        const tj = Date.parse(rows[j].timestamp)
        const diffDays = (tj - ts) / 86_400_000
        if (rows[j].tcgplayer_market && rows[j].tcgplayer_market! > 0) {
          if (diffDays < 0 && diffDays >= -3) prior.push(rows[j].tcgplayer_market!)
          if (diffDays > 0 && diffDays <= 3) next.push(rows[j].tcgplayer_market!)
        }
      }
      if (prior.length >= 1 && next.length >= 1) {
        const priorMed = median(prior)
        const nextMed = median(next)
        const reverted = Math.abs(nextMed - priorMed) <= cfg.revertTolerance * priorMed
        if (priorMed > 0 && value > cfg.spikeMultiplier * priorMed && reverted) {
          signals++
          if (localAnchor === value) localAnchor = priorMed
        }
      }

      if (signals >= 1) flagged.push({ row, signals, localAnchor })
    }

    // Safety net — never drop more than 25% of a card's history in one pass.
    const wouldDelete = flagged.filter((f) => f.signals >= 3).length
    if (wouldDelete > total * cfg.maxDeleteFraction) {
      result.cardsSkipped++
      if (result.details) {
        result.details.push({
          cardId: card_id,
          deleted: 0,
          winsorized: 0,
          flagged: flagged.length,
          skipped: true,
        })
      }
      console.warn(
        `[scrub] card=${card_id} would delete ${wouldDelete}/${total} rows (>${cfg.maxDeleteFraction * 100}%); skipping — re-check anchor`,
      )
      continue
    }

    let deleted = 0
    let winsorized = 0
    for (const f of flagged) {
      if (f.signals >= 3) {
        deleteStmt.run(f.row.rowid)
        deleted++
      } else if (f.signals === 2) {
        winsorizeStmt.run(f.localAnchor, f.row.rowid)
        winsorized++
      }
    }

    result.rowsDeleted += deleted
    result.rowsWinsorized += winsorized
    result.rowsFlagged += flagged.length
    if (result.details) {
      result.details.push({ cardId: card_id, deleted, winsorized, flagged: flagged.length, skipped: false })
    }
  }

  console.log(
    `[scrub] examined=${result.cardsExamined} deleted=${result.rowsDeleted} ` +
      `winsorized=${result.rowsWinsorized} flagged=${result.rowsFlagged} skipped=${result.cardsSkipped}`,
  )
  return result
}
