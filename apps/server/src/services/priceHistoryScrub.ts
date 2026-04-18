import type Database from 'better-sqlite3'

/**
 * Multi-signal `price_history` scrub.
 *
 * The ingest gate in `pokemontcg.ts` prevents new bad ticks, but we have
 * historical contamination that predates it. Rather than a single-threshold
 * delete, this scrub uses five *independent* signals and a conservative
 * "how many fired" decision policy, which is the standard robust-statistics
 * approach to automated data cleaning:
 *
 *   Signal A — Cross-source disagreement (same row).
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
 *   Signal D — TCG self-inconsistency (row-local, no cross-source needed).
 *     TCGPlayer ships `tcgplayer_low` on every row — that's the minimum of
 *     current real listings. A `tcgplayer_market` > 5× its own `low` means
 *     TCG's own envelope disagrees with itself (usually a single absurd
 *     listing skewed the market calculation). This fires on contaminated
 *     rows that pre-date the PriceCharting backfill, which is exactly the
 *     regime the rest of the signals struggled with — they need PC data in
 *     the same row that often doesn't exist for legacy history.
 *
 *   Signal E — Card-level PC anchor.
 *     `cards.pc_price_raw` is the current PriceCharting raw median for the
 *     card — a slow-moving, volume-smoothed reference. If a row's
 *     `tcgplayer_market` is > 5× that anchor and the anchor exists and is
 *     non-trivial ($5+), the row is almost certainly a data glitch. Unlike
 *     Signal A, this doesn't require PC data in the same row; it uses the
 *     point-in-time PC reference stamped on the `cards` table.
 *
 * Decision policy per flagged row:
 *   - ≥3 signals fire  → delete (high confidence error).
 *   - 2 signals fire   → winsorize: replace value with the best available
 *                         anchor and tag `source='scrubbed-winsorized'`.
 *   - 1 signal fires   → leave alone, but log.
 *
 * Winsorize anchor preference (most → least trusted):
 *   1. `cards.pc_price_raw` (stable, PC-sourced, card-level ground truth).
 *   2. Row's own `pricecharting_median` (when Signal A fired).
 *   3. Row's own `tcgplayer_low` (TCGPlayer's floor — real listings).
 *   4. 14-day rolling window median.
 *   5. Row's current value (fallback; shouldn't happen post-flag).
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
  tcgplayer_low: number | null
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
  /** Signal D: multiplier over a row's own tcgplayer_low. */
  tcgSelfMultiplier?: number
  /** Signal E: multiplier over the card-level pc_price_raw anchor. */
  pcAnchorMultiplier?: number
  /**
   * Hard-cap: if `tcgplayer_market > pcAnchorHardMultiplier × pc_price_raw`,
   * act immediately regardless of other signals (single-signal winsorize).
   * This catches the "TCG and PC disagree across the whole series" pattern
   * that the 2-signal gate misses — basep-40 (Pokémon Center) had a TCG
   * listing band of $7k vs a PC raw anchor of $1.1k, stable across 30+
   * days, so no other signal fired. 3× is a confident threshold — legit
   * TCG-leads-PC moves during a real pump rarely exceed 2×, and PC's
   * nightly re-anchor catches up within 24h.
   */
  pcAnchorHardMultiplier?: number
  /** Signal E: minimum anchor value below which we don't trust it. */
  pcAnchorFloor?: number
  windowDays?: number
  maxDeleteFraction?: number
  /**
   * Max number of scrub passes per card. Continuous-block contamination
   * (e.g. two weeks where every row is bad) hides from MAD on pass 1
   * because the rolling window is dominated by peers that are also bad.
   * Re-running with the egregious rows already winsorized recomputes
   * MAD on cleaner data and catches the remainder. Default 3 is enough
   * for every real contamination pattern we've seen; convergence is
   * quick because each pass strictly monotonically reduces the bad set.
   */
  maxPasses?: number
}

const DEFAULTS = {
  crossSourceMultiplier: 2.5,
  // 3-MAD is the standard robust-statistics outlier threshold (5-MAD is
  // "extreme-only"; 3-MAD ≈ 99.7th percentile for thin tails, and handles
  // fat-tailed card price distributions without over-firing). We used 5
  // initially to be conservative but that left mid-tier contamination
  // (2× overshoots) inside the "normal" band on cards with continuous-
  // block contamination where MAD's own window is dominated by bad peers.
  madMultiplier: 3,
  spikeMultiplier: 2,
  revertTolerance: 0.2,
  // 2× for D and E is aggressive but safe because winsorize requires TWO
  // independent signals to fire. D (market vs own low) and E (market vs
  // card-level PC raw) firing together means BOTH TCG's floor AND the
  // cross-source PC reference disagree with the row's market ≥2×, which
  // is not legitimate volatility — that's a data error. The 2× threshold
  // is what catches rows that are "bad but not egregious" (e.g. $1400
  // where truth is $750), which 3× was leaving behind.
  tcgSelfMultiplier: 2,
  pcAnchorMultiplier: 2,
  pcAnchorHardMultiplier: 3,
  pcAnchorFloor: 5,
  windowDays: 7,
  maxDeleteFraction: 0.25,
  // 5 passes is plenty — iteration converges monotonically and in
  // practice Mew-shaped contamination (2 weeks continuous) settles in
  // 2-3 passes. We cap at 5 just to bound worst-case runtime.
  maxPasses: 5,
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
    `SELECT rowid, card_id, timestamp, tcgplayer_market, tcgplayer_low, pricecharting_median, source
     FROM price_history
     WHERE card_id = ? AND tcgplayer_market IS NOT NULL AND tcgplayer_market > 0
     ORDER BY timestamp ASC`,
  )
  const cardAnchorStmt = db.prepare(
    `SELECT pc_price_raw FROM cards WHERE id = ?`,
  )
  const deleteStmt = db.prepare(`DELETE FROM price_history WHERE rowid = ?`)
  const winsorizeStmt = db.prepare(
    `UPDATE price_history SET tcgplayer_market = ?, source = 'scrubbed-winsorized' WHERE rowid = ?`,
  )

  const windowMs = cfg.windowDays * 86_400_000

  for (const { card_id, total } of cards) {
    result.cardsExamined++
    // Card-level PC anchor is constant for this card across all passes.
    const cardAnchor =
      (cardAnchorStmt.get(card_id) as { pc_price_raw: number | null } | undefined)?.pc_price_raw ?? null
    const pcAnchorUsable = cardAnchor != null && cardAnchor >= cfg.pcAnchorFloor

    let cardDeleted = 0
    let cardWinsorized = 0
    let cardFlagged = 0
    let cardSkipped = false

    // Iteration loop. Each pass re-reads rows fresh (so MAD/window signals
    // see the effect of prior passes' winsorizations), evaluates all five
    // signals, and acts. We break early once a pass produces no changes,
    // which is the common case for non-contaminated cards (single pass).
    for (let pass = 0; pass < cfg.maxPasses; pass++) {
      const rows = rowsStmt.all(card_id) as HistoryRow[]
      if (rows.length === 0) break

      // Precompute parsed timestamps once per pass — Date.parse is one of
      // the hottest ops in the inner loops and doing it O(N²) times for
      // large cards is what makes global scrubs slow.
      const tsArr = new Float64Array(rows.length)
      for (let k = 0; k < rows.length; k++) tsArr[k] = Date.parse(rows[k].timestamp)

      type Flag = { row: HistoryRow; signals: number; localAnchor: number }
      const flagged: Flag[] = []

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        if (row.source === 'pricecharting-chart') continue // never touch PC-sourced rows
        const value = row.tcgplayer_market!
        const ts = tsArr[i]
        if (!Number.isFinite(ts)) continue

        // Build a symmetric 14-day window around this row (7d before + 7d after).
        // rows are sorted ASC by timestamp, so we can walk outward from `i`
        // and break once we leave the window on each side — reduces this
        // from O(N²) to O(N·W) where W = avg neighbours per row.
        const winLow = ts - windowMs
        const winHigh = ts + windowMs
        const neighbours: number[] = []
        for (let j = i - 1; j >= 0; j--) {
          const tj = tsArr[j]
          if (tj < winLow) break
          const v = rows[j].tcgplayer_market
          if (v != null && v > 0) neighbours.push(v)
        }
        for (let j = i + 1; j < rows.length; j++) {
          const tj = tsArr[j]
          if (tj > winHigh) break
          const v = rows[j].tcgplayer_market
          if (v != null && v > 0) neighbours.push(v)
        }

        let signals = 0
        // Collect every candidate anchor a signal produces, then pick the
        // most-trusted one at the end (see preference list in file header).
        const anchors: { value: number; prio: number }[] = []
        const addAnchor = (v: number | null | undefined, prio: number) => {
          if (v != null && Number.isFinite(v) && v > 0) anchors.push({ value: v, prio })
        }

        // Signal A: cross-source disagreement (same-row PC).
        if (row.pricecharting_median && row.pricecharting_median > 0) {
          if (value > cfg.crossSourceMultiplier * row.pricecharting_median) {
            signals++
            addAnchor(row.pricecharting_median, 2)
          }
        }

        // Signal B: MAD outlier on the rolling window.
        if (neighbours.length >= 3) {
          const m = median(neighbours)
          const d = mad(neighbours, m)
          const scale = Math.max(d, 0.05 * m)
          if (scale > 0 && Math.abs(value - m) > cfg.madMultiplier * scale) {
            signals++
            addAnchor(m, 4)
          }
        }

        // Signal C: spike-and-revert. Same sort-exploiting trick — walk
        // outward from i within the 3-day window and break when we leave.
        const prior: number[] = []
        const next: number[] = []
        const threeDaysMs = 3 * 86_400_000
        for (let j = i - 1; j >= 0; j--) {
          const tj = tsArr[j]
          const diff = ts - tj
          if (diff > threeDaysMs) break
          const v = rows[j].tcgplayer_market
          if (v != null && v > 0) prior.push(v)
        }
        for (let j = i + 1; j < rows.length; j++) {
          const tj = tsArr[j]
          const diff = tj - ts
          if (diff > threeDaysMs) break
          const v = rows[j].tcgplayer_market
          if (v != null && v > 0) next.push(v)
        }
        if (prior.length >= 1 && next.length >= 1) {
          const priorMed = median(prior)
          const nextMed = median(next)
          const reverted = Math.abs(nextMed - priorMed) <= cfg.revertTolerance * priorMed
          if (priorMed > 0 && value > cfg.spikeMultiplier * priorMed && reverted) {
            signals++
            addAnchor(priorMed, 4)
          }
        }

        // Signal D: TCG self-inconsistency — market >> its own low.
        if (row.tcgplayer_low != null && row.tcgplayer_low > 0) {
          if (value > cfg.tcgSelfMultiplier * row.tcgplayer_low) {
            signals++
            addAnchor(row.tcgplayer_low, 3)
          }
        }

        // Signal E: card-level PC anchor. Fires at 2× (1 signal).
        const signalsBeforeE = signals
        if (pcAnchorUsable && cardAnchor! > 0) {
          if (value > cfg.pcAnchorMultiplier * cardAnchor!) {
            signals++
            addAnchor(cardAnchor!, 1)
          }
          // Hard-cap: if E fires at ≥3× AND nothing else fired, promote to
          // 2-signal status so it alone is winsorize-sufficient. We gate on
          // "no other signal fired" so hard-cap never escalates an already-
          // double-signaled row into delete territory — winsorize is the
          // right action when we have a high-confidence PC anchor and the
          // delete path (3+ signals) is reserved for "multiple independent
          // witnesses of trash data" cases where reconstruction is risky.
          if (
            signalsBeforeE === 0 &&
            value > cfg.pcAnchorHardMultiplier * cardAnchor!
          ) {
            signals++ // 1 → 2, winsorize
          }
        }

        if (signals >= 1) {
          const sorted = [...anchors].sort((a, b) => a.prio - b.prio)
          const localAnchor = sorted.length ? sorted[0].value : value
          flagged.push({ row, signals, localAnchor })
        }
      }

      // Safety net — check cumulative (across passes) deletion fraction.
      const wouldDelete = flagged.filter((f) => f.signals >= 3).length
      if ((cardDeleted + wouldDelete) > total * cfg.maxDeleteFraction) {
        cardSkipped = true
        cardFlagged += flagged.length
        console.warn(
          `[scrub] card=${card_id} pass=${pass} would push total deletions to ${
            cardDeleted + wouldDelete
          }/${total} (>${cfg.maxDeleteFraction * 100}%); halting passes — re-check anchor`,
        )
        break
      }

      let passDeleted = 0
      let passWinsorized = 0
      for (const f of flagged) {
        if (f.signals >= 3) {
          deleteStmt.run(f.row.rowid)
          passDeleted++
        } else if (f.signals === 2) {
          winsorizeStmt.run(f.localAnchor, f.row.rowid)
          passWinsorized++
        }
      }

      cardDeleted += passDeleted
      cardWinsorized += passWinsorized
      cardFlagged += flagged.length

      // Converged: nothing changed this pass, further passes would be no-ops.
      if (passDeleted === 0 && passWinsorized === 0) break
    }

    result.rowsDeleted += cardDeleted
    result.rowsWinsorized += cardWinsorized
    result.rowsFlagged += cardFlagged
    if (cardSkipped) result.cardsSkipped++
    if (result.details) {
      result.details.push({
        cardId: card_id,
        deleted: cardDeleted,
        winsorized: cardWinsorized,
        flagged: cardFlagged,
        skipped: cardSkipped,
      })
    }
  }

  console.log(
    `[scrub] examined=${result.cardsExamined} deleted=${result.rowsDeleted} ` +
      `winsorized=${result.rowsWinsorized} flagged=${result.rowsFlagged} skipped=${result.cardsSkipped}`,
  )
  return result
}
