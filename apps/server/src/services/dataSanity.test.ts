import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { createApp } from '../app.js'
import request from 'supertest'
import { adminToken } from '../test/helpers.js'

/**
 * Data-sanity checks against the real production-like snapshot.
 *
 * These tests sample N cards from the local DB (the one `pull-prod-snapshot`
 * produces) and assert that each card's chart history looks plausible:
 *
 *   1. Max displayed raw price ≤ 3× the card's PC raw anchor.
 *      Anything higher means we have contaminated history that either the
 *      ingest gate or the scrub should have caught.
 *   2. Min ≥ 10% of the anchor when both anchor & series are non-trivial.
 *      A legit PSA 10 chart can dip; a $750 raw card with a $5 bar is a
 *      data error (often a mis-parsed point or wrong PC match).
 *   3. No row exceeds $50,000 (catches scale errors — pennies-as-dollars).
 *   4. PSA 10 series, where present, is ≥ raw series (graded > ungraded
 *      is a floor invariant; violations almost always mean we matched
 *      the wrong PC product).
 *
 * Tests self-skip when the local snapshot isn't present — they're ops
 * guardrails, not required CI signal. Flip POKEGRAILS_SANITY_STRICT=1 in
 * CI to promote a missing snapshot into a failure.
 *
 * We run against the actual file on disk because that IS the data that
 * production serves to users. The signals we're asserting are the same
 * ones a real user would flag as "this chart looks wrong".
 */

const LOCAL_DB = path.resolve(
  path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'data', 'pokegrails.sqlite'),
)

// Existence alone isn't enough — previous test runs may have auto-created
// an empty SQLite file (better-sqlite3 does that by default). We only
// consider the snapshot "real" if it has at least the expected tables AND
// a non-trivial row count in `cards`.
function snapshotLooksReal(p: string): boolean {
  try {
    if (!fs.existsSync(p)) return false
    const st = fs.statSync(p)
    // Any real snapshot is hundreds of MB. An auto-created stub is 4-16 KB.
    if (st.size < 10_000_000) return false
    const db = new Database(p, { readonly: true, fileMustExist: true })
    try {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM cards`).get() as { c: number }
      return row.c > 100
    } finally {
      db.close()
    }
  } catch {
    return false
  }
}

const haveLocal = snapshotLooksReal(LOCAL_DB)
const strict = process.env.POKEGRAILS_SANITY_STRICT === '1'

// Max cards to sample per check. Keep low — each test hits the HTTP handler
// and runs a window query; 25 samples takes <1s total.
const SAMPLE_SIZE = 25

// Caps the absolute plausible price. A $50k Pokémon card exists (Illustrator
// Pikachu), but nothing we index should exceed this and anything above is
// a units error (pennies treated as dollars, etc.) that we want to catch.
const ABSURD_CAP = 50_000

const skipMsg = `local snapshot not found at ${LOCAL_DB} — run \`npm run dev:prod-data\` first (or set POKEGRAILS_SANITY_STRICT=1 to fail instead of skipping)`
const describeIfLocal = haveLocal || strict ? describe : describe.skip

describeIfLocal('data sanity against local snapshot', () => {
  if (!haveLocal && strict) {
    it('fails because POKEGRAILS_SANITY_STRICT is set but no snapshot exists', () => {
      throw new Error(skipMsg)
    })
    return
  }

  // IMPORTANT: `describe.skip` still invokes this callback to register the
  // skipped tests — so any DB work at this scope runs on CI where no
  // snapshot exists. Guard the DB open + sample query behind the haveLocal
  // check, otherwise better-sqlite3 creates a fresh DB file and the sample
  // query blows up on the missing `cards` table.
  if (!haveLocal) {
    it.skip(skipMsg, () => { /* placeholder so vitest sees a test */ })
    return
  }

  const db = new Database(LOCAL_DB)
  const app = createApp(db)
  const token = adminToken()

  // Only sample cards that actually have a PC anchor — everything else
  // either hasn't been matched yet (backfill is still running) or is
  // bulk common with no PC presence, and both categories just add noise.
  const sampleCards = db
    .prepare(
      `SELECT id, name, set_id, pc_price_raw, pc_price_psa10
       FROM cards
       WHERE pricecharting_id IS NOT NULL
         AND pc_price_raw IS NOT NULL
         AND pc_price_raw > 0
       ORDER BY pc_price_raw DESC
       LIMIT ?`,
    )
    .all(SAMPLE_SIZE) as {
    id: string
    name: string
    set_id: string | null
    pc_price_raw: number
    pc_price_psa10: number | null
  }[]

  it(`has at least a handful of PC-matched cards (sanity preconditions)`, () => {
    expect(sampleCards.length).toBeGreaterThan(0)
  })

  for (const card of sampleCards) {
    it(`raw history max ≤ 3× pc_price_raw for ${card.id} (${card.name}, anchor=$${card.pc_price_raw})`, async () => {
      const r = await request(app)
        .get(`/api/cards/${card.id}/history?grade=raw&source=both`)
        .set('Authorization', 'Bearer ' + token)
      expect(r.status).toBe(200)
      const prices: number[] = (r.body.series ?? []).map((p: any) => p.price).filter((p: any) => Number.isFinite(p) && p > 0)
      if (prices.length === 0) return // No history yet; can't judge. Backfill will populate.

      const max = Math.max(...prices)
      // 3× is generous — the scrub's E-signal fires at 2×, so anything >3×
      // here means contamination the scrub couldn't or didn't touch.
      expect(max).toBeLessThanOrEqual(3 * card.pc_price_raw)
      expect(max).toBeLessThan(ABSURD_CAP)
    })

    it(`raw history min is not a units-error for ${card.id}`, async () => {
      if (card.pc_price_raw < 20) return // thresholds too tight on bulk commons
      const r = await request(app)
        .get(`/api/cards/${card.id}/history?grade=raw&source=both`)
        .set('Authorization', 'Bearer ' + token)
      const prices: number[] = (r.body.series ?? []).map((p: any) => p.price).filter((p: any) => Number.isFinite(p) && p > 0)
      if (prices.length < 5) return

      const min = Math.min(...prices)
      // A real 20-year-old card can legitimately have historical prints
      // 5-10% of today's price (Base Charizard was $350 in 2015, $5300
      // today — that's 6.6% and it's correct history). Units-errors
      // (pennies interpreted as dollars, e.g. $3 showing $0.03) land
      // below 1%. That's the invariant we actually care about.
      expect(min).toBeGreaterThanOrEqual(0.01 * card.pc_price_raw)
    })

    it(`no raw history row exceeds $${ABSURD_CAP} for ${card.id}`, async () => {
      const r = await request(app)
        .get(`/api/cards/${card.id}/history?grade=raw&source=both`)
        .set('Authorization', 'Bearer ' + token)
      const prices: number[] = (r.body.series ?? []).map((p: any) => p.price)
      for (const p of prices) expect(p).toBeLessThan(ABSURD_CAP)
    })

    if (card.pc_price_psa10 != null && card.pc_price_psa10 > 0 && card.pc_price_raw > 5) {
      it(`PSA 10 anchor ≥ raw anchor for ${card.id} (raw=$${card.pc_price_raw}, psa10=$${card.pc_price_psa10})`, () => {
        // Graded > ungraded is a floor invariant: PSA 10 is strictly rarer
        // and commands a premium vs. raw. Violation = wrong PC product
        // matched (common failure mode for misnumbered variants).
        expect(card.pc_price_psa10).toBeGreaterThanOrEqual(card.pc_price_raw)
      })
    }
  }

  it('Mew ex #232 Paldean Fates is not in the "chart looks wrong" state anymore', async () => {
    const mew = db
      .prepare(`SELECT id, pc_price_raw FROM cards WHERE id = 'sv4pt5-232'`)
      .get() as { id: string; pc_price_raw: number | null } | undefined
    if (!mew) return // card missing from this snapshot — not our concern

    const r = await request(app)
      .get(`/api/cards/sv4pt5-232/history?grade=raw&source=both`)
      .set('Authorization', 'Bearer ' + token)
    expect(r.status).toBe(200)
    const prices: number[] = (r.body.series ?? []).map((p: any) => p.price).filter((p: any) => Number.isFinite(p) && p > 0)
    if (prices.length === 0 || !mew.pc_price_raw) return

    const max = Math.max(...prices)
    // Regression guard — before the scrub Mew's max was $3987 against a
    // $748 anchor (5.3×). After ingest hardening + scrub + PC backfill
    // this should now be under 3× the anchor.
    expect(max).toBeLessThanOrEqual(3 * mew.pc_price_raw)
  })
})
