# CODEMAP

Path → purpose. Keep in sync; it's the index that avoids re-exploring.

## Implemented

| path | purpose |
|---|---|
| `src/math/lnfact.ts` | lazily-grown log-factorial table; `lnC`, `binom` |
| `src/math/hyper.ts` | univariate hypergeometric: `support`, `pmf`, `cdf`, `sfAtLeast`, `between` |
| `src/math/exact.ts` | **test-only** BigInt exact oracle |
| `src/math/brute.ts` | **test-only** full draw enumeration; independent of every DP path |
| `src/math/boxdp.ts` | multivariate interval DP → full `P(n)` curve in one pass |
| `src/math/expr.ts` | query AST, `Box`/`Dnf` types, box intersection + subsumption |
| `src/math/normalize.ts` | `atLeastK` expansion, NOT elimination, DNF distribution, pruning, up-set detection |
| `src/math/evaluate.ts` | DNF → inclusion–exclusion → curve, Kahan-summed, box-curve memo |
| `src/math/analyze.ts` | ΔP, knee, peak, feasible windows, draws-needed |
| `src/math/parse.ts` | text query language (`A>=2 & !B`, `any 2 of (…)`, `true`/`false`) |
| `src/math/print.ts` | inverse of `parse` — renders an id-based AST with current group names |
| `src/model/turns.ts` | draw-count <-> turn mapping (opening hand, on-the-play, draws/turn) |
| `src/math/frontier.ts` | monotone-only: minimal sufficient vectors (greedy descent from the max corner) |
| `src/math/allocate.ts` | slot-budget optimizer: maximize P for a budget (primal), fewest slots for a target (dual) |
| `src/math/expr.ts` (`pruneGroups`) | explicit, user-triggered removal of atoms mentioning a deleted group |
| `src/math/builder.ts` | unified builder model: query = OR of combos, each combo = "at least k of its rows" (k=rows.length is AND) |
| `src/harness/main.ts` | plain-DOM dev harness — deck editor, unified combo query builder (per-combo "require all" checkbox / threshold) + text, Result card (chart/table toggle, steepest-gain marker, starting-hand line, multi-group phantoms + hover/click-to-focus + tooltip), grid (values/Δboth interaction term; Δcopy/Δdraw kept in code, commented out of the UI), frontier |
| `src/harness/harness.html` | harness template; `<!--BUNDLE-->` is replaced at build time |
| `scripts/build-harness.mjs` | esbuild → one self-contained `dist-harness/harness.html` |
| `scripts/smoke-harness.mjs` | boots the built harness in jsdom and asserts every view renders |
| `src/math/hyper.test.ts` | oracle comparison, pmf normalization, monotonicity, degenerate inputs |
| `src/ui/App.tsx` | M0 smoke view — a single `P(X≥1)` table. Replaced at M2 |
| `src/main.tsx` | React entry |
| `src/index.css` | global tokens + table styling |
| `vite.config.ts` | `base: '/deck-calc/'` in production; vitest config lives here |

## Planned (empty dirs, see PLAN.md)

| path | purpose |
|---|---|
| `src/math/frontier.ts` | monotone-only: staircase + minimal sufficient vectors |
| `src/math/allocate.ts` | deck-slot budget optimizer (exact for small m, greedy above) |
| `src/model/` | deck, query list, turn↔draw-count mapping |
| `src/serde/hash.ts` | versioned URL-hash state codec |
| `src/worker/` | calc worker + promise client w/ stale-response dropping |
| `src/ui/` | DeckEditor, QueryBuilder, CurveView, GridView, FrontierView, AllocateView |
