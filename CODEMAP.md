# CODEMAP

Path → purpose. Keep in sync; it's the index that avoids re-exploring.

## Implemented

| path | purpose |
|---|---|
| `PLAN.md` | math/architecture plan — algorithms, watch-outs, resolved bugs |
| `UI_DESIGN.md` | real product IA/mockup decisions (layout, combos card, advisor, curve/grid) |
| `src/state/AppState.tsx` | React context + reducer; query TEXT is the single source of truth, never a cached AST |
| `src/state/useQueryModel.tsx` | parse→normalize→evaluate→analyze→decompile pipeline, computed once via `QueryModelProvider` and shared through context (not recomputed per consumer) |
| `src/ui/numberInput.ts` | `parseNumOr0` — shared fix for controlled number inputs stalling visually blank on backspace-to-empty |
| `src/ui/DeckEditor.tsx` | deck size / hand / mulligans (one line), group rows (name+input grouped, delete isolated — a real spacing bug caught in mockup review), rename re-derives query text, delete auto-prunes references with a visible notice (deliberate reversal of the earlier "never silently prune" rule — see below) |
| `src/ui/CombosEditor.tsx` | accordion combo builder: NOT toggle, comparator/number inputs, all-or-nothing fallback to text for real nesting, manual "Edit as text" escape hatch |
| `src/ui/ResultView.tsx` | status line, target % control, Chart/Table tab strip, per-draw table (visibleKnee-fixed), live SVG curve |
| `src/ui/App.tsx` | app shell: rail (deck+combos) + draggable resize handle + main (result). Rail width is a localStorage view preference, deliberately outside AppState. Grid/Suggestions tabs and mobile not yet built |
| `src/ui/App.smoke.test.tsx` | React Testing Library smoke test — 11 tests. Caught 2 real bugs (unquoted seed query; rename not re-deriving query text) that typecheck alone missed |
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
| `src/model/turns.ts` | draw-count <-> turn mapping (opening hand, on-the-play, draws/turn, approximated mulligans) |
| `src/math/frontier.ts` | monotone-only: minimal sufficient vectors (greedy descent from the max corner) |
| `src/math/allocate.ts` | slot-budget optimizer: maximize P for a budget (primal), fewest slots for a target (dual) |
| `src/math/expr.ts` (`pruneGroups`) | explicit, user-triggered removal of atoms mentioning a deleted group |
| `src/math/builder.ts` | builder model: query = OR of combos, each combo a plain AND (no per-combo threshold — see PLAN §4c) |
| `src/harness/main.ts` | plain-DOM dev harness — deck editor, combo query builder + text, export/import, "path to target" advisor (by-turn draws-vs-copies comparison), Result card (chart/table toggle, steepest-gain marker, starting-hand line, multi-group phantoms + hover/click-to-focus + tooltip), grid (values/Δboth interaction term; Δcopy/Δdraw kept in code, commented out of the UI), frontier |
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
