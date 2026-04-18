# PriceCharting ingest & scrub — production runbook

This is the operator cheatsheet for rolling out the PriceCharting-as-truth
data pipeline to prod. All endpoints require admin auth. The service
already runs this logic automatically via cron (see
`apps/server/src/services/cron.ts`) but you can trigger everything
manually for one-off operations, incident response, or rollouts.

## The data model in one paragraph

PriceCharting is the definitive source for card prices. TCGPlayer is
secondary and supplementary. Per card we store:

- `cards.pc_price_raw` / `pc_price_psa10` / ... — current point-in-time PC
  grade anchors refreshed by the backfill.
- `price_history` (one row per card/day) — `tcgplayer_market` is live TCG,
  `pricecharting_median` is backfilled PC. Scrubbed rows get
  `source='scrubbed-winsorized'` so we can tell them apart later.
- `card_grade_history` — full per-grade PC time series (raw / 7 / 8 / 9 /
  9.5 / PSA 10). The UI source toggle reads this directly.

The chart endpoint's `source=both` prefers PC over TCG on same-day
collisions. Users can override via `source=tcgplayer` or
`source=pricecharting`.

## Rolling out to prod — the happy path

Pre-req: you've deployed the `dev` branch to prod (or the commit that
contains the new backfill scope options + hard-cap scrub).

```bash
# 1. Sanity check — admin token grabbed from a logged-in session cookie.
export PROD=https://pokegrails.com
export ADMIN_TOKEN=<admin user's JWT>

# 2. Backfill top 500 most-valuable cards first (~20 min). These are
#    the cards users care about and where bad data is most visible.
curl -X POST "$PROD/api/internal/backfill-pricecharting?limit=500&skipSealed=1" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 3. Watch the server log. You'll see "[pc-backfill] COMPLETE — matched:
#    X, scraped: Y, grade-history rows: Z" when done. Typical output for
#    limit=500: "matched: ~0, scraped: ~495, grade-history rows: ~100k".

# 4. Run the scrub to winsorize any legacy TCG contamination using the
#    new PC anchors we just populated.
curl -X POST "$PROD/api/internal/scrub-price-history" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 5. Spot-check the Mew that started all this:
curl -s "$PROD/api/cards/sv4pt5-232/history?grade=raw&source=both" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.series | (max_by(.price).price), (min_by(.price).price)'
# Expect: max ≤ 3× pc_price_raw (~$2250), min ≥ 1% of anchor.

# 6. Full catalog — kick off in a screen/tmux session, it takes ~6 hours.
curl -X POST "$PROD/api/internal/backfill-pricecharting" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

## Triage: single-card debugging

Got a user report that a specific card's chart looks wrong? You can
re-backfill just that card (skips all sealed scrapes, runs in ~5s):

```bash
curl -X POST "$PROD/api/internal/backfill-pricecharting?cardId=sv4pt5-232&force=1" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

`force=1` re-scrapes even if we already have ≥6 PC rows for the card.
Drop the flag to be idempotent.

Then scope-scrub the same card:

```bash
curl -X POST "$PROD/api/internal/scrub-price-history?cardId=sv4pt5-232" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

## Automated guardrails

`apps/server/src/services/dataSanity.test.ts` runs a sample of real
cards against the live local snapshot and asserts:

- Max raw price ≤ 3× `pc_price_raw` — catches contamination the scrub
  should have handled.
- Min raw price ≥ 1% of `pc_price_raw` — catches units errors
  (pennies-as-dollars, mis-parsed points).
- PSA 10 anchor ≥ raw anchor — floor invariant; violations mean we
  matched the wrong PC product.
- No row exceeds $50,000 — scale-error cap.
- Mew ex #232 specifically — regression guard for the original bug.

These tests skip gracefully when no local snapshot exists, so CI doesn't
need the DB. Set `POKEGRAILS_SANITY_STRICT=1` to flip skip → fail.
Run locally with:

```bash
cd apps/server
npx vitest run src/services/dataSanity.test.ts
```

## Cron schedule (automatic)

Already wired in `cron.ts`:
- **02:00 UTC daily** — PC backfill (full catalog, idempotent).
- **04:00 UTC Sunday** — price_history scrub (weekly cleanup).

## Scrub algorithm summary

The scrub is a 5-signal multi-pass algorithm on `price_history`:

| Signal | Fires when                                                    | Witness weight |
|--------|---------------------------------------------------------------|----------------|
| A      | `abs(tcg_market - pc_median)/pc_median > 2.5` (same row)      | 1              |
| B      | `abs(value - median) > 3 × MAD` over a 7-day window           | 1              |
| C      | Spike ≥5× prior median that reverts within 3 days             | 1              |
| D      | `tcg_market > 2 × tcg_low` (self-inconsistency)               | 1              |
| E      | `tcg_market > 2 × cards.pc_price_raw`                         | 1              |
| E-hard | E fires AND `tcg_market > 3 × pc_price_raw` AND nothing else  | +1 bonus       |

- ≥3 signals → **delete** row (outlier so contaminated we'd rather lose it).
- 2 signals → **winsorize** to the highest-priority anchor
  (pc_price_raw > pricecharting_median > tcgplayer_low > window median).
- Loops up to 5 passes per card so MAD recalibrates on progressively
  cleaner data; bails early if a pass changes nothing.
- Hard-caps total card-level deletes at 25% (safety net; logs and skips
  otherwise).

## Debugging: did the scrub touch a specific row?

```sql
SELECT timestamp, tcgplayer_market, source
FROM price_history
WHERE card_id = 'sv4pt5-232' AND source = 'scrubbed-winsorized'
ORDER BY timestamp DESC LIMIT 20;
```

`source='scrubbed-winsorized'` is the marker.
