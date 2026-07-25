# CODEMAP

Path → purpose. Keep in sync; it's the index that avoids re-exploring.

## Implemented

| path | purpose |
|---|---|
| `src/math/lnfact.ts` | lazily-grown log-factorial table; `lnC`, `binom` |
| `src/math/hyper.ts` | univariate hypergeometric: `support`, `pmf`, `cdf`, `sfAtLeast`, `between` |
| `src/math/exact.ts` | **test-only** BigInt exact oracle |
| `src/math/hyper.test.ts` | oracle comparison, pmf normalization, monotonicity, degenerate inputs |
| `src/ui/App.tsx` | M0 smoke view — a single `P(X≥1)` table. Replaced at M2 |
| `src/main.tsx` | React entry |
| `src/index.css` | global tokens + table styling |
| `vite.config.ts` | `base: '/deck-calc/'` in production; vitest config lives here |

## Planned (empty dirs, see PLAN.md)

| path | purpose |
|---|---|
| `src/math/boxdp.ts` | multivariate interval-constrained DP → full `P(n)` curve in one pass |
| `src/math/expr.ts` | query AST (atom / and / or / not / atLeastK) |
| `src/math/normalize.ts` | AST → DNF of boxes; NOT elimination; pruning; monotonicity flag |
| `src/math/evaluate.ts` | DNF → inclusion–exclusion → curve |
| `src/math/analyze.ts` | ΔP, knee, argmax, feasible window |
| `src/math/frontier.ts` | monotone-only: staircase + minimal sufficient vectors |
| `src/math/allocate.ts` | deck-slot budget optimizer (exact for small m, greedy above) |
| `src/model/` | deck, query list, turn↔draw-count mapping |
| `src/serde/hash.ts` | versioned URL-hash state codec |
| `src/worker/` | calc worker + promise client w/ stale-response dropping |
| `src/ui/` | DeckEditor, QueryBuilder, CurveView, GridView, FrontierView, AllocateView |
