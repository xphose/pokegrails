/**
 * Read-side display filter for the card history chart.
 *
 * Problem: even after the multi-signal scrub, price_history still contains
 * contamination on cards whose PC anchor wasn't populated when the scrub
 * ran (the backfill is slow). Pikachu VMAX (swshp-SWSH286) has PC raw =
 * $5 and 21 rows over $1000 that the scrub couldn't touch because:
 *   - no PC anchor at scrub time → Signal E didn't fire
 *   - continuous-block contamination → Signal B (MAD window) sees all
 *     neighbours as $3000 too, so no row looks "unusual"
 *   - Signal D (market >> own low) fires alone → 1 signal, which is the
 *     "flag only, leave alone" decision. By design.
 * So the chart rendered a rail of bad $3000 rows.
 *
 * This filter acts at response time against a known-good anchor. It never
 * mutates the DB — just trims the rows that are outside a plausible band.
 * Trade-offs:
 *   - Band is [anchor × 0.15, anchor × 3.0]. That keeps legitimate
 *     volatility (a card tripling in a month is real) but kills the 10x+
 *     contamination that dominates the regressions.
 *   - If the filter would trim more than 60% of the rows, we *don't* apply
 *     it at all and return the raw series. Reasoning: a card where most
 *     "true" values are outside the band means our anchor is stale or
 *     wrong (e.g. newly re-released card; legit price shift) and the UI
 *     showing a partial chart is worse than showing the dirty data. The
 *     scrub will handle the anchor issue on its next run.
 *   - No anchor → no filter. Nothing else to fall back on without
 *     replicating the scrub's statistical signals at response time, and
 *     the scrub already handles anchorless cards as well as it can.
 */

export interface HistoryPoint {
  timestamp: string
  price: number
  source: string
}

/** Sanity band around the anchor. Tuned on the Apr 2026 data audit. */
export const DISPLAY_FILTER_LO_MULTIPLIER = 0.15
export const DISPLAY_FILTER_HI_MULTIPLIER = 3.0
/** If the filter rejects more than this share of rows, bail and return raw. */
export const DISPLAY_FILTER_MAX_REJECT_FRACTION = 0.6

export interface DisplayFilterResult {
  series: HistoryPoint[]
  /**
   * Count of rows the filter dropped. Zero when no anchor or when the
   * "bail out because too many got rejected" branch triggered.
   */
  filtered: number
}

export function applyHistoryDisplayFilter(
  rows: HistoryPoint[],
  anchor: number | null | undefined,
): DisplayFilterResult {
  if (!anchor || anchor <= 0 || !Number.isFinite(anchor)) {
    return { series: rows, filtered: 0 }
  }
  const lo = anchor * DISPLAY_FILTER_LO_MULTIPLIER
  const hi = anchor * DISPLAY_FILTER_HI_MULTIPLIER

  const kept: HistoryPoint[] = []
  let rejected = 0
  for (const r of rows) {
    if (!Number.isFinite(r.price) || r.price <= 0) {
      rejected++
      continue
    }
    if (r.price < lo || r.price > hi) {
      rejected++
      continue
    }
    kept.push(r)
  }

  if (rows.length === 0) return { series: [], filtered: 0 }
  if (rejected / rows.length > DISPLAY_FILTER_MAX_REJECT_FRACTION) {
    // Anchor likely wrong / stale. Trust the raw series for now; the next
    // weekly scrub will refresh the anchor from the backfill.
    return { series: rows, filtered: 0 }
  }
  return { series: kept, filtered: rejected }
}
