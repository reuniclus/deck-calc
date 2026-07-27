# CODEMAP

Path → purpose. Keep in sync; it's the index that avoids re-exploring.

## Implemented

| path | purpose |
|---|---|
| `PLAN.md` | math/architecture plan — algorithms, watch-outs, resolved bugs |
| `UI_DESIGN.md` | real product IA/mockup decisions (layout, combos card, advisor, curve/grid) |
| `src/state/hashState.ts` | URL hash encode/decode (UI_DESIGN.md §6) — base64url of {deckSize, groups, query} only. Target %/turn config/adviseTurn deliberately excluded (session/view preferences, not shareable state) |
| `src/ui/CopyLinkButton.tsx` | copies `window.location.href` — nothing to compute, `AppState`'s effect already keeps the hash in sync |
| `src/state/AppState.tsx` | React context + reducer; query TEXT is the single source of truth, never a cached AST |
| `src/state/useQueryModel.tsx` | parse→normalize→evaluate→analyze→decompile pipeline, computed once via `QueryModelProvider` and shared through context (not recomputed per consumer) |
| `src/ui/numberInput.ts` | `parseNumOr0` — shared fix for controlled number inputs stalling visually blank on backspace-to-empty |
| `src/ui/DeckEditor.tsx` | deck size / hand / mulligans (one line), group rows (name+input grouped, delete isolated — a real spacing bug caught in mockup review), rename re-derives query text, delete auto-prunes references with a visible notice (deliberate reversal of the earlier "never silently prune" rule — see below) |
| `src/ui/CombosEditor.tsx` | accordion combo builder: NOT toggle, comparator/number inputs (hard-capped widths), all-or-nothing fallback to text for real nesting, manual "Edit as text" escape hatch, arbitrary-length group names truncate via a dedicated bounded span |
| `src/ui/AdvisorStrip.tsx` | persistent above the curve regardless of tab: "Goal: X% by turn T" + first-turn-draw checkbox (always live), condensed advice line, "See suggestions" link. Uses hi=deckSize search box, not the query's own current-count-bound hi |
| `src/ui/SuggestionsTab.tsx` | full breakdown: every minimal vector (frontier.ts), best split of current slots, fewest slots for target (allocate.ts) — same scope restriction as the strip (single monotone AND-clause) |
| `src/ui/GridTab.tsx` | 2D grid: sweep one group's copies × cards drawn. Sliding window centered on the real count (ported bugfix, not reintroduced — fixed 0..12 range was a real bug earlier), values or interaction-term (`Δ` both) mode |
| `src/math/suggestSearch.ts` | single shared dispatch between the fast staircase (frontier.ts) and general brute-force search (generalSuggest.ts), used by AdvisorStrip, SuggestionsTab, AND the chart's phantom curves. This existed as 3 independently-duplicated copies until one of them (the chart's) drifted out of sync when general-path support was added — phantom lines silently stopped appearing for any OR/non-monotone query even though the advisor/Suggestions tab correctly showed real data for the same query. Consolidated to prevent a repeat |
| `src/state/suggestionCurves.ts` | full curves for every distinct minimal suggested composition (via suggestSearch.ts, any query shape), deduped by EXACT curve equality (not visual similarity — confirmed symmetric-vector collapse works, e.g. (9,10)/(10,9) really are one curve) |
| `src/ui/ResultView.tsx` | status line, Chart/Table/Grid/Suggestions tabs (each with a distinct `tab-panel-*` wrapper class). ChartTab is self-sufficient (pulls its own data like GridTab/SuggestionsTab do): per-card gridlines, axis labels, target/hand/turn-T reference lines, deduped suggestion curves, per-LINE hover (Y-aware, not just X-aware nearest-column) -- tooltip and pip show ONLY the specific hovered line (main/clause/suggestion), boosted to full opacity while others dim further, instead of dumping every line's value at once; one low-opacity line PER OR CLAUSE alongside the full-opacity combined-OR curve, each independently evaluable regardless of monotonicity. Kept mounted (display-toggled) so switching tabs doesn't reset a tab's own local state. Tab state lives in `App.tsx`'s `Layout`, lifted up so `AdvisorStrip`'s "See suggestions" link can switch it |
| `src/ui/MobileNav.tsx` | mobile sticky bar (count chips, +/- and tappable number) + drawer. Drawer renders the SAME `DeckEditor`/`CombosEditor` components as the desktop rail — never a duplicate copy of the editing logic. Sentinel-based "scrolled past the rail" detection via `IntersectionObserver` (jsdom has none at all — stubbed in tests, see CLAUDE.md §10) |
| `src/ui/App.tsx` | app shell: rail (deck+combos, with the mobile sentinel as its last child) + draggable resize handle (desktop) + main (advisor + result). `@media (max-width: 720px)` in `index.css` collapses to one column and swaps in the sticky bar/drawer |
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
