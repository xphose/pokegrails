# PokéEdge — Analytics Models Audit

> Phase 0 discovery completed. Stack: Node.js / TypeScript / Express 5 / better-sqlite3 / React 19 / Recharts / Tailwind 4 / Vitest.

## Existing Analytics Summary

| Area | Implementation | File(s) |
|------|---------------|---------|
| Pricing model | Heuristic: `base × 1.19^pull × 1.41^des`, shrunk to peer median | `services/model.ts` |
| AI score | Composite 0–1 from momentum, scarcity, sentiment, lifecycle, growth | `services/investment.ts` |
| Future value | 12-month projection from tier, rarity, trends, buzz, age, 30d trend | `services/investment.ts` |
| Reddit buzz | Keyword matching (not NLP), exponential-decay score | `services/reddit.ts` |
| Anomaly check | Simple >40% threshold on last 8 price points | `app.ts` (`isAnomalyRisky`) |
| Social momentum | Client-side Reddit/Trends blend for dashboard | `lib/social-momentum.ts` |
| Track record | Prediction snapshot diffs, hit rate, confidence | `services/trackRecord.ts` |

## Model Audit

| # | Model | Status | Notes |
|---|-------|--------|-------|
| 1 | Time-Series Price Forecasting | **NO** | Price history exists but no forecasting/extrapolation |
| 2 | Gradient Boosting Price Predictor | **PARTIAL** | `predicted_price` uses heuristic multipliers, not trained ML. Has feature extraction. |
| 3 | Random Forest Feature Importance | **NO** | No global feature importance analysis exists |
| 4 | LSTM Momentum Detector | **PARTIAL** | `social-momentum.ts` + `investment.ts` have heuristic momentum (Reddit+Trends), not time-series pattern detection |
| 5 | Sentiment Analysis | **PARTIAL** | `investment.ts` has heuristic sentiment (avg of momentum+desirability). `reddit.ts` does keyword matching, not NLP |
| 6 | PSA Pop Supply Shock | **NO** | No PSA pop data tables exist; no supply shock detection |
| 7 | Anomaly / Spike Detector | **PARTIAL** | `isAnomalyRisky` is a simple >40% threshold; no statistical detection, no classification, no history |
| 8 | Cointegration Analyzer | **NO** | No price-pair correlation analysis |
| 9 | Bayesian Price Estimator | **PARTIAL** | `shrinkPredictedToPeers` blends toward peer median (Bayesian-like), but not formal prior-posterior with credible intervals |
| 10 | Card Clustering Engine | **NO** | No clustering or archetype segmentation |
| 11 | PCA Variance Decomposer | **NO** | No dimensionality analysis |

## Implementation Plan

All models adapted to **TypeScript / Node.js** using `simple-statistics` (already in `package.json`, currently unused) for linear regression, statistics, and correlation. No Python dependencies needed.

### New Dependencies

| Package | Workspace | Justification |
|---------|-----------|---------------|
| `simple-statistics` | server | Already installed — linear regression, statistics, z-scores, correlation |

No new dependencies required. All models implemented in pure TypeScript.
