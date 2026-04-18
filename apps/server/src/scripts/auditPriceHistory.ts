/**
 * CLI wrapper around priceHistoryAudit. Prints offenders (cards whose
 * post-filter history still has a >100× spread) and, with --fix, runs
 * the multi-signal scrub against each offender in place.
 *
 * Usage:
 *   npm run audit -w server
 *   npm run audit -w server -- --threshold=50
 *   npm run audit -w server -- --fix
 *   npm run audit -w server -- --limit=200
 */
import { getDb } from '../db/connection.js'
import { auditPriceHistory } from '../services/priceHistoryAudit.js'
import { scrubPriceHistory } from '../services/priceHistoryScrub.js'

function parseArg(name: string, fallback?: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`))
  if (arg) return arg.slice(name.length + 3)
  if (process.argv.includes(`--${name}`)) return 'true'
  return fallback
}

function main() {
  const db = getDb()
  const threshold = Number(parseArg('threshold', '100')) || 100
  const maxOffenders = Number(parseArg('limit', '100')) || 100
  const fix = parseArg('fix') === 'true'
  const cardId = parseArg('card')

  console.log(`[audit] threshold=${threshold}× maxOffenders=${maxOffenders} fix=${fix}${cardId ? ` card=${cardId}` : ''}`)
  const result = auditPriceHistory(db, { thresholdRatio: threshold, maxOffenders, cardId })
  const { summary, offenders } = result

  console.log('[audit] summary:')
  console.log(`  cards_with_history   = ${summary.cards_with_history}`)
  console.log(`  offenders (≥${threshold}×)  = ${summary.offenders}`)
  console.log(`  2×-10×               = ${summary.buckets.ratio_2x_to_10x}`)
  console.log(`  10×-100×             = ${summary.buckets.ratio_10x_to_100x}`)
  console.log(`  100×-1000×           = ${summary.buckets.ratio_100x_to_1000x}`)
  console.log(`  >1000×               = ${summary.buckets.ratio_over_1000x}`)

  if (offenders.length === 0) {
    console.log('[audit] no offenders')
    return
  }

  console.log('[audit] worst offenders:')
  for (const o of offenders.slice(0, 25)) {
    const anchorStr = o.anchor != null ? `$${o.anchor.toFixed(2)}` : '—'
    console.log(
      `  ${o.card_id.padEnd(18)} ${String(o.name).slice(0, 30).padEnd(30)} ratio=${o.post_filter_ratio.toFixed(1).padStart(8)}× ` +
        `min=$${o.post_filter_min.toFixed(2)} max=$${o.post_filter_max.toFixed(2)} anchor=${anchorStr}${o.filter_bailed ? ' [filter-bailed]' : ''}`,
    )
  }

  if (!fix) {
    console.log('[audit] run with --fix to scrub all offenders')
    return
  }

  console.log(`[audit] --fix: running scrub on ${offenders.length} offenders…`)
  let totalDeleted = 0
  let totalWinsorized = 0
  let fixed = 0
  for (const o of offenders) {
    const scrub = scrubPriceHistory(db, { cardId: o.card_id })
    totalDeleted += scrub.rowsDeleted
    totalWinsorized += scrub.rowsWinsorized
    if (scrub.rowsDeleted + scrub.rowsWinsorized > 0) fixed++
  }
  console.log(
    `[audit] scrub complete — ${fixed}/${offenders.length} cards modified, ${totalDeleted} rows deleted, ${totalWinsorized} rows winsorized`,
  )

  const after = auditPriceHistory(db, { thresholdRatio: threshold, maxOffenders: 0, cardId })
  console.log(`[audit] offenders after scrub: ${after.summary.offenders}`)
}

main()
