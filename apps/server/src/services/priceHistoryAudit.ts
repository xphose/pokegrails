import type Database from 'better-sqlite3'
import { applyHistoryDisplayFilter } from './historyDisplayFilter.js'

/**
 * Full-catalog data-quality audit for `price_history`.
 *
 * Why it exists: the multi-signal scrub (priceHistoryScrub.ts) handles
 * the *cleanup* side, and the display filter (historyDisplayFilter.ts)
 * hides obvious garbage at render time. What we *don't* have is a
 * catalog-wide monitor that answers the question "after both of those
 * ran, which cards still look contaminated?". Without that, a slow
 * regression (e.g. ingest introduces a new class of outlier, or the PC
 * backfill misses a set) can quietly accumulate for weeks.
 *
 * The audit mirrors how the UI renders a card's history chart — same
 * anchor, same filter — and reports any card whose post-filter series
 * still has a min/max ratio above some threshold. That's the shape of
 * contamination a user actually sees: "the chart starts at $3000 and
 * drops to $5". A clean card should have a spread well under 10× over
 * the history window; anything over 100× is almost certainly a data
 * problem rather than a real price move.
 *
 * Output is a sorted list of offenders (worst first) with enough
 * metadata to triage: current PC anchor, current market price, series
 * length, and a couple of sample rows explaining the spread.
 */

export interface AuditCardReport {
  card_id: string
  name: string | null
  set_id: string | null
  /** Anchor used by the display filter (pc_price_raw || market_price). */
  anchor: number | null
  /** market_price from the `cards` row (may differ from anchor). */
  market_price: number | null
  /** Total rows read for this card before display-filter. */
  rows_total: number
  /** Rows the display filter kept (or all rows if it bailed out). */
  rows_kept: number
  /** min/max of the kept series (post-filter). */
  post_filter_min: number
  post_filter_max: number
  /** Ratio max/min of the post-filter series. */
  post_filter_ratio: number
  /** Extreme rows so a human can sanity-check without a DB query. */
  sample_low: { timestamp: string; price: number; source: string | null } | null
  sample_high: { timestamp: string; price: number; source: string | null } | null
  /** True if the display filter bailed out (too many rows would be rejected). */
  filter_bailed: boolean
}

export interface AuditSummary {
  /** How many cards had any price_history rows at all. */
  cards_with_history: number
  /** How many cards came back as offenders (ratio ≥ threshold). */
  offenders: number
  /** Ratio bucket counts — gives a shape-of-the-problem view. */
  buckets: {
    ratio_2x_to_10x: number
    ratio_10x_to_100x: number
    ratio_100x_to_1000x: number
    ratio_over_1000x: number
  }
  threshold: number
}

export interface AuditResult {
  summary: AuditSummary
  offenders: AuditCardReport[]
}

export interface AuditOptions {
  /**
   * Min post-filter max/min ratio for a card to count as an "offender".
   * Default 100 (matches the user-facing bug report: "$3000 to $5 on one
   * chart"). A ratio of 10 would flag legitimate volatile cards; 100 is
   * the point where we're nearly certain it's contamination.
   */
  thresholdRatio?: number
  /**
   * Cap on the offenders list returned. Summary counts are never capped;
   * only the detail list. Default 100 — enough for a person to triage.
   */
  maxOffenders?: number
  /**
   * Skip cards with fewer than this many history rows. Small series are
   * noisy (a legit 3-row series with one low outlier looks like a huge
   * ratio) and aren't what users see in the "fat contamination chart"
   * bug. Default 10.
   */
  minRowsPerCard?: number
  /** Restrict to a single card (debugging). */
  cardId?: string
}

const DEFAULT_THRESHOLD = 100
const DEFAULT_MAX_OFFENDERS = 100
const DEFAULT_MIN_ROWS = 10

interface CardRow {
  id: string
  name: string | null
  set_id: string | null
  pc_price_raw: number | null
  market_price: number | null
}

interface HistoryRow {
  timestamp: string
  tcgplayer_market: number | null
  pricecharting_median: number | null
  source: string | null
}

export function auditPriceHistory(db: Database.Database, opts: AuditOptions = {}): AuditResult {
  const threshold = opts.thresholdRatio ?? DEFAULT_THRESHOLD
  const maxOffenders = opts.maxOffenders ?? DEFAULT_MAX_OFFENDERS
  const minRows = opts.minRowsPerCard ?? DEFAULT_MIN_ROWS

  const cardsStmt = opts.cardId
    ? db.prepare(
        `SELECT id, name, set_id, pc_price_raw, market_price
         FROM cards WHERE id = ?`,
      )
    : db.prepare(
        // Only cards that have ANY price_history — the bare table can run
        // to hundreds of thousands of rows; the join keeps us to cards
        // that could actually show a chart.
        `SELECT c.id, c.name, c.set_id, c.pc_price_raw, c.market_price
         FROM cards c
         WHERE EXISTS (SELECT 1 FROM price_history h WHERE h.card_id = c.id)`,
      )

  const cards = (opts.cardId ? cardsStmt.all(opts.cardId) : cardsStmt.all()) as CardRow[]

  const historyStmt = db.prepare(
    `SELECT timestamp, tcgplayer_market, pricecharting_median, source
     FROM price_history
     WHERE card_id = ?
     ORDER BY timestamp ASC`,
  )

  const summary: AuditSummary = {
    cards_with_history: 0,
    offenders: 0,
    buckets: {
      ratio_2x_to_10x: 0,
      ratio_10x_to_100x: 0,
      ratio_100x_to_1000x: 0,
      ratio_over_1000x: 0,
    },
    threshold,
  }

  const offenders: AuditCardReport[] = []

  for (const card of cards) {
    const rows = historyStmt.all(card.id) as HistoryRow[]
    if (rows.length < minRows) continue

    summary.cards_with_history++

    // Anchor mirrors the /api/cards/:id/history route. pc_price_raw
    // wins; market_price is a secondary fallback for cards the PC
    // backfill hasn't reached yet.
    const anchor =
      card.pc_price_raw != null && card.pc_price_raw > 0
        ? card.pc_price_raw
        : card.market_price != null && card.market_price > 0
          ? card.market_price
          : null

    // Collapse the (price_history -> display chart) projection. Prefer
    // pricecharting_median when present (that's what the UI shows on the
    // PriceCharting chart); fall back to tcgplayer_market (TCGPlayer
    // chart). Audit both concurrently — we don't want to miss a card
    // that's clean on one source and filthy on the other.
    const ratios: { label: 'tcg' | 'pc'; points: { timestamp: string; price: number; source: string }[] }[] = [
      {
        label: 'tcg',
        points: rows
          .filter((r) => r.tcgplayer_market != null && r.tcgplayer_market > 0)
          .map((r) => ({ timestamp: r.timestamp, price: r.tcgplayer_market as number, source: r.source ?? 'tcgplayer' })),
      },
      {
        label: 'pc',
        points: rows
          .filter((r) => r.pricecharting_median != null && r.pricecharting_median > 0)
          .map((r) => ({ timestamp: r.timestamp, price: r.pricecharting_median as number, source: r.source ?? 'pricecharting' })),
      },
    ]

    // Take the worst of the two sources — if either chart looks bad,
    // the card is an offender. Keep the series that produced the worst
    // ratio for the report body.
    let worst: AuditCardReport | null = null

    for (const { points } of ratios) {
      if (points.length < minRows) continue
      const filtered = applyHistoryDisplayFilter(points, anchor)
      const kept = filtered.series
      if (kept.length === 0) continue
      let lo = kept[0].price
      let hi = kept[0].price
      let loRow: (typeof kept)[number] = kept[0]
      let hiRow: (typeof kept)[number] = kept[0]
      for (const p of kept) {
        if (p.price < lo) {
          lo = p.price
          loRow = p
        }
        if (p.price > hi) {
          hi = p.price
          hiRow = p
        }
      }
      if (lo <= 0) continue
      const ratio = hi / lo
      if (!worst || ratio > worst.post_filter_ratio) {
        worst = {
          card_id: card.id,
          name: card.name,
          set_id: card.set_id,
          anchor,
          market_price: card.market_price,
          rows_total: points.length,
          rows_kept: kept.length,
          post_filter_min: lo,
          post_filter_max: hi,
          post_filter_ratio: ratio,
          sample_low: { timestamp: loRow.timestamp, price: lo, source: loRow.source },
          sample_high: { timestamp: hiRow.timestamp, price: hi, source: hiRow.source },
          filter_bailed: filtered.filtered === 0 && kept.length === points.length && anchor != null,
        }
      }
    }

    if (!worst) continue

    // Bucket counts cover the whole catalog, not just offenders, so a
    // dashboard can show shape without needing the detail list.
    if (worst.post_filter_ratio >= 2 && worst.post_filter_ratio < 10) summary.buckets.ratio_2x_to_10x++
    else if (worst.post_filter_ratio >= 10 && worst.post_filter_ratio < 100) summary.buckets.ratio_10x_to_100x++
    else if (worst.post_filter_ratio >= 100 && worst.post_filter_ratio < 1000) summary.buckets.ratio_100x_to_1000x++
    else if (worst.post_filter_ratio >= 1000) summary.buckets.ratio_over_1000x++

    if (worst.post_filter_ratio >= threshold) {
      summary.offenders++
      offenders.push(worst)
    }
  }

  offenders.sort((a, b) => b.post_filter_ratio - a.post_filter_ratio)
  return { summary, offenders: offenders.slice(0, maxOffenders) }
}
