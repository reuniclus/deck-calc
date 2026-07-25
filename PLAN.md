# Deck Probability Calculator — Plan

Deckulator-class hypergeometric tool, w/ locked deck size, derived `others`, boolean combo queries, 2-variable distributions, marginal-value/diminishing-returns analysis, and a slot-allocation optimizer.

---

## 0. Stack

| concern | choice | why |
|---|---|---|
| build | Vite + TS (strict) | fast, static output, trivial Pages deploy |
| UI | React 19 + function components | stated preference |
| state | zustand (or `useReducer`+context) | no redux ceremony; worker-friendly plain objects |
| charts | Recharts (curves) + hand-rolled canvas (heatmap) | contour/heatmap easier by hand than fighting a lib |
| 3D | plotly.js, lazy-loaded, **v2 only** | ~3MB; heatmap+contour conveys the same info |
| tests | vitest + fast-check | property tests are the real safety net here |
| styling | Tailwind (or CSS modules) | either fine; pick day 1, don't mix |
| deploy | GitHub Actions → GitHub Pages | see §11 |

Node 20+. No backend, ever. All state in URL hash.

---

## 1. Repo layout

```
.
├── CLAUDE.md               # build/test/lint commands, conventions
├── CODEMAP.md              # path → purpose index
├── PLAN.md                 # this file
├── .github/workflows/deploy.yml
├── index.html
├── vite.config.ts          # base: '/<repo>/'
└── src/
    ├── math/               # PURE TS. no React, no deps, worker-portable
    │   ├── lnfact.ts       # lazily-extended log-factorial table
    │   ├── hyper.ts        # univariate pmf/cdf/sf
    │   ├── boxdp.ts        # multivariate DP → full curve over n
    │   ├── expr.ts         # query AST
    │   ├── normalize.ts    # AST → DNF<Box>, NOT-elimination, pruning
    │   ├── evaluate.ts     # DNF → inclusion–exclusion → curve
    │   ├── analyze.ts      # ΔP, knee, argmax, feasible window
    │   ├── frontier.ts     # monotone: staircase + minimal-vector antichain
    │   ├── allocate.ts     # slot-budget optimizer (exact + greedy)
    │   └── exact.ts        # BigInt rational oracle — TESTS ONLY
    ├── model/
    │   ├── deck.ts         # deck type + invariants + reducer
    │   ├── query.ts        # query list reducer
    │   └── turns.ts        # opening hand / draw-step → n mapping
    ├── worker/
    │   ├── calc.worker.ts
    │   └── client.ts       # promise-wrapped postMessage, req-id matching
    ├── serde/
    │   └── hash.ts         # state ⇄ URL hash, versioned
    └── ui/
        ├── DeckEditor/
        ├── QueryBuilder/
        ├── CurveView/
        ├── GridView/       # heatmap + contours
        ├── FrontierView/   # tradeoff table
        └── AllocateView/
```

Rule: **nothing in `src/math` imports from outside `src/math`.** It's the whole reason the worker split and the test oracle are cheap.

---

## 2. Deck model

```ts
type GroupId = string;               // nanoid — NEVER an array index

interface Group { id: GroupId; name: string; count: number; color: string; }

interface Deck {
  deckSize: number;
  sizeMode: 'locked' | 'derived';
  groups: Group[];
}

// derived, never stored:
const others = (d: Deck) => d.deckSize - sum(d.groups.map(g => g.count));
```

- `locked`: user sets `deckSize`; `others` is read-only and absorbs every edit. This is the requested behavior and it falls out for free from the derivation — zero drift possible.
- `derived`: `others` becomes an editable pseudo-group, `deckSize = Σ counts + others`.
- Toggling modes is lossless in both directions.

### Invalid states are allowed
`Σ counts > deckSize` → `others < 0`. **Do not clamp.** Show a red banner, disable calculation, let the user keep typing. Clamping mid-keystroke (someone typing "12" passes through "1") is the single most infuriating bug class in numeric UIs. Keep inputs as strings in local component state, commit to the model on valid parse/blur.

### Groups must be disjoint
The multivariate hypergeometric requires a **partition** of the deck. A card counted in two groups silently corrupts every number. Deckulator enforces this; so do we, in v1.

v2 overlapping tags (deferred, documented so it isn't designed out): user defines disjoint *atoms*, tags are unions of atoms. A tag constraint becomes a sum-over-atoms half-space, not a box → DP state grows to `(groupIdx, s, τ₁…τ_t)`. Tractable to ~3 tags, explodes after.

---

## 3. Math core

### 3.1 log-factorial table
```ts
lnFact[n]                      // lazily grown, cached
lnC(n,k) = lnFact[n] - lnFact[k] - lnFact[n-k]
```
Don't fix the table size at build time — deck sizes range 40 (MTG-ish) → 60 (YGO) → 100 (Commander) → 250+ (weird formats). Grow on demand.

### 3.2 Univariate
`P(X ≥ k)` for deck `N`, group `K`, draw `n`:
```
pmf(x) = exp(lnC(K,x) + lnC(N-K, n-x) - lnC(N,n))
```
float64 rel. error ~1e-15. BigInt only as a test oracle, never at runtime.

### 3.3 Multivariate box DP — the workhorse

Atom = interval, not a threshold: `lo_g ≤ X_g ≤ hi_g`. Box = one interval per constrained group.

```
dp[0][0] = 1
dp[j][s] = Σ_{x=lo_j}^{min(hi_j, K_j, s)} dp[j-1][s-x] · C(K_j, x)

R = N - Σ_g K_g                      // unconstrained pool (others + unconstrained groups)
P(n) = ( Σ_s dp[m][s] · C(R, n-s) ) / C(N, n)
```

Complexity `O(m · s_max · maxK)`. Microseconds.

**Key property: the DP does not depend on `n`.** One DP pass yields `P(n)` for *every* draw count simultaneously. Everything downstream gets cheaper:

- "P vs draws" curve = 1 DP
- "draws needed for target%" = scan a finished array (no binary search, no monotonicity assumption needed)
- 2D grid over `(n, K_g)` = one DP **per row**, not per cell

Marginalization justification: unconstrained groups collapse into `R` correctly because the multivariate hypergeometric marginalizes over unmentioned categories.

Magnitude note: `dp` values are raw integer counts held in doubles. `C(250,125) ≈ 1e73` — fine (double max 1e308). Exact integer representation is lost above 2^53 but relative error stays ~1e-16, which is all we need. If `N > ~1000` ever matters, normalize `dp` by `C(N,n)` incrementally or move to log-space. Not a v1 concern.

### 3.4 Query language

```ts
type Expr =
  | { t:'atom'; g:GroupId; lo:number; hi:number }
  | { t:'and'|'or'; kids:Expr[] }
  | { t:'not'; kid:Expr }
  | { t:'atLeastK'; k:number; kids:Expr[] };   // "any 2 of these 3 combos"
```

Closure algebra — this is why arbitrary nesting works:

| op | result |
|---|---|
| AND of boxes | elementwise `max(lo)`, `min(hi)` → **still a box** |
| NOT of atom | `[0, lo-1] ∪ [hi+1, K]` → union of ≤2 atoms |
| OR | DNF, resolved by inclusion–exclusion |
| atLeastK | OR over `C(c,k)` intersections → free |

Pipeline:
```
Expr → pushNots (De Morgan + interval complement)
     → distribute → DNF<Box>
     → prune + dedupe
     → inclusion–exclusion → one boxDP per term
```

Every I-E term is a single box → **one existing DP call**. No new math for arbitrary boolean combos.

### 3.5 Pruning
Kill a term before running the DP if:
- any `lo > hi` (empty)
- any `lo > K_g` (impossible)
- `Σ lo > n_max` or `Σ hi < required` (infeasible)
- box ⊆ another box already in the term set (dominated)

Most of `2^c` typically vanishes. Still hard-cap `c ≤ 8` clauses w/ a UI warning.

### 3.6 Inclusion–exclusion precision
Terms alternate sign → cancellation. With ≤2^8 terms each in [0,1] the loss is ~1e-13; acceptable. But:
- Kahan-sum the I-E accumulation.
- Clamp to `[0,1]` **only at the very end**.
- If the pre-clamp value is outside `[-1e-9, 1+1e-9]`, that's a **bug, not rounding** — throw in dev builds. This assertion catches malformed DNF faster than any test.

---

## 4. Monotonicity — and where it breaks

`P` is nondecreasing in `n` and in each `K_g` **iff the event is an up-set** in the draw partial order.

Proof sketch (coupling): relabel one `others` card as group-`g`; every draw's `X_g` weakly increases, all `X_j` unchanged.

Up-set ⟺ every box in the DNF is a pure `≥` box (`hi_g === K_g` for all g), and no NOT survived normalization. Unions of up-sets are up-sets, so a DNF of `≥`-boxes qualifies.

**Admitting `≤` / `exactly` / NOT breaks it.** "Exactly 1 copy of X" rises, peaks, then falls as you draw more. That invalidates binary search, staircase walking, and dominance pruning.

Detect statically at normalize time and branch the solver:

| query | solver | answer shape |
|---|---|---|
| monotone | staircase walk + dominance pruning | minimal sufficient vectors (antichain) |
| non-monotone | full scan (cheap — one DP gives the curve) | feasible **set** of `n`, plus argmax & max `P` |

The UI must reflect this. A non-monotone answer is not "draw 12 cards", it's:

> `P ≥ 90%` for `n ∈ [9,14]` — peak **94% @ n=11**

("peak" = max of `P(n)` over `n`, with its argmax. Monotone queries have no interior peak — `P` climbs to exactly 1.0 at `n = N`. Good test invariant.)

If the target is never reached: report max achievable and where, never a bare "impossible".

---

## 5. Analysis features

### 5.1 Differentials (free)
`ΔP(n) = P(n+1) − P(n)` — the whole array is already computed.

`n` is **not** where an optimum lives for a monotone query (more cards always help). So `ΔP` over `n` is for *display*, not optimization:
- `ΔP` column in the draws table (`+4.2% / card`) = value of a cantrip
- knee marker at `argmax ΔP` = where diminishing returns start
- "cards needed to gain +1%" in the tail → makes the 90→99% cliff visceral

Skip 2nd differences as a displayed number: noisy on a discrete lattice, and `argmax ΔP` carries the same intuition legibly. Never *assume* `ΔP` is unimodal in code — just take `argmax` of the array.

### 5.2 The real optimum: deck composition
Adding a combo piece isn't free — it **displaces an `others` card**. Fixed `N` makes it a substitution, and substitution has a genuine interior optimum.

```
maximize P(K₁…K_m ; n)   s.t.  Σ K_g ≤ N
```

Concrete: need 1×A **and** 1×B, `N=40`, 8 slots to spend, `n=7`. `8A/0B → P=0`; `4A/4B → max`. Non-obvious for asymmetric combos (need 2×A + 1×B → skewed allocation).

Marginal quantity:
```
∂_g = P(K_g+1, others−1) − P(K_g, others)
```
= gain from swapping one filler card into group `g`. `m` DP calls per step.

| m | method |
|---|---|
| ≤3 | exact — enumerate compositions of budget `B` into `m` parts, `C(B+m-1, m-1)` ≈ 10³ |
| 4 | exact, 10⁴–10⁵ DPs → worker |
| ≥5 | greedy on `∂_g` + pairwise-swap local search |

Greedy is a **heuristic**. `P` is usually submodular in slots per group, but don't claim it in general. Use the exact solver on small `m` to validate greedy on overlapping cases; log divergences.

### 5.3 Dual form — ship this one
```
minimize Σ K_g   s.t.  P ≥ target
```
"Fewest deck slots to hit 90% by turn 3." A scalar cost collapses the antichain into a single answer — report ties, they're real deckbuilding choices.

### 4b. Builder model simplification: combos, not modes

The three original builder modes ("all of these" / "any of these" / "at least N of
these") turned out to be one shape: a combo (a list of conditions) with a threshold
k — "at least k of these conditions." k = rows.length is exactly AND; several
1-row combos each with k=1 is exactly the old OR; a single combo with k < rows.length
is exactly the old atLeastK. Unifying to `FlatQuery = { clauses: Clause[] }`,
`Clause = { rows: Row[], k: number }` removed the mode selector entirely and made
"AND pre-loaded, add more combos if you want OR" the natural default rather than a
special case — a fresh single combo simply has k = rows.length. UI: a "require all"
checkbox per combo (checked ⟺ k===rows.length) with a threshold number revealed
underneath when unchecked, shown only for combos with 2+ conditions.

### 3b. [Fixed] Steepest-gain marker could appear before the starting hand

`analyze.ts`'s knee (steepest single-card ΔP) is computed over the WHOLE curve, by
design — it's turn-agnostic pure math with no concept of an opening hand, and that's
correct: coupling it to turn config would make it unusable in a context without one.
But nothing at the display layer was restricting where that marker gets DRAWN, so a
curve whose biggest single-card jump happens to fall before the opening hand (common
— the very first card is often the steepest, since P is 0 before it) would mark
"steepest" at a draw count that isn't a real turn yet. Fixed at the harness level:
`visibleKnee()` in `main.ts` re-scans `a.deltas` restricted to `n >= effectiveOpeningHand`,
and the table, graph marker, and summary line all use it instead of the raw `a.knee`.
Confirmed with a real (not manufactured) case: the existing non-monotone smoke-test
query's true global knee sits at card 1, which the fix correctly moved to card 8 once
restricted to the visible range.

### 3c. Mulligans (approximated)

Modeled as a straight reduction of the effective opening hand
(`effectiveOpeningHand = max(0, openingHand - mulligans)`) in `model/turns.ts`, used
everywhere a draw count needs to know "when does the game actually start" — table/grid
trimming, the graph's starting-hand line, and (via §3b) where the steepest-gain marker
is allowed to appear. Placed in the existing Turns panel next to starting hand size,
defaulting to 0 (exactly today's behavior, verified byte-for-byte against the
pre-mulligan curve in `turns.test.ts`).

This is a deliberate, documented approximation, not the real London mulligan rule. The
actual rule — draw a fresh 7, then keep whichever (7-mulligans) cards you choose,
bottoming the rest — is a "best subset" order-statistic problem: a real mulligan hand
is never worse than this model assumes, only better, because you get to pick which
cards to keep. For a single tracked group that's a closed-form transform of the
univariate hypergeometric (keep min(draws, hand size) successes); for a general
multi-group boolean query, "best subset" isn't even well-defined without knowing which
combination you're optimizing for. Flagged as a genuine future math project, not
implemented now — the flat reduction is the conservative/honest placeholder, and the
UI states this caveat plainly rather than implying more precision than it has.

### 4c. Removed: "any k of" / per-combo threshold

The per-combo "require at least k of these" threshold (added in §4b) turned out to
be a false economy: `atLeastK` has no single-token text spelling (it printed as the
keyword-based `any k of (...)`), and that keyword was the one piece of syntax
distinct from everything else in the grammar — confusing on its own, and, per the
insight that prompted removing it, redundant: `atLeastK(k, rows)` is exactly the OR
of every k-sized subset of those rows, which the builder can already author
directly as separate combos. Removed the keyword from `parse.ts` entirely and the
threshold UI from the builder; `builder.ts`'s `Clause` is back to `{ rows: Row[] }`
with no `k`. `printExpr` still handles an `atLeastK` **Expr** node correctly if one
is ever constructed directly (e.g. by future code, or a query authored before this
change) — it expands to the equivalent OR-of-ANDs text via the same combinatorial
expansion `normalize.ts` already used internally (`expandAtLeastK`, now exported),
so nothing the math layer can produce becomes unparseable; the builder simply has
no path to construct one anymore, which is the actual UI simplification requested.

### 5.3b Interaction term (grid "Δ both")

`interaction(k,n) = P(k,n) - P(k,n-1) - P(k-1,n) + P(k-1,n-1)` — the discrete mixed
partial. Positive: the two levers (an extra copy, an extra draw) compound. Negative:
they overlap/substitute (typical of an OR-shaped query, where either alone already
covers most of the outcome). Implemented in the harness (`diffAt`, mode `'both'`);
the single-axis `dCopy`/`dDraw` toggles are commented out in the HTML (not deleted —
code stays in `main.ts`) since this mode answers "where's the optimum" more directly
than either alone. True eigenvectors of the local Hessian were considered and
rejected: the two axes (draws vs. deck slots) have no shared unit, so a principal
curvature direction isn't actionable — you can't act on "0.6 draws + 0.8 copies."
Where a real exchange rate exists (slot-for-slot at a fixed budget), `allocate.ts`
already answers it directly.

### 5.4 Grid / surface
Sample the DP over a 2D lattice `(cards drawn) × (group size)`; overlay the staircase as an isoprobability contour. Contour *spacing* already is the diminishing-returns picture — widening bands = saturation. Cheaper and more legible than any derivative readout.

Use a perceptually-uniform, colorblind-safe scale (viridis/magma). Never rainbow.

---

## 6. Turn model

Explicit config, never hardcoded:
```ts
{ openingHand: 7, drawsPerTurn: 1, onThePlay: boolean, mulligans: 0 }
n(turn) = openingHand + drawsPerTurn * (turn - (onThePlay ? 1 : 0))
```
Off-by-one here is the most likely *silently wrong* result in the whole app, because nothing looks broken. Unit-test the mapping table directly against a hand-written expectation.

Mulligans (London etc.) change the distribution, not just `n` — out of scope for v1, but keep the field so the shape doesn't have to change later.

---

## 7. Perf budget

| workload | cost | where |
|---|---|---|
| single curve, `c ≤ 4` (~15 I-E terms) | <1ms | main thread |
| 60×40 grid, univariate | instant | main thread |
| grid × I-E, `c ≥ 6` | 10⁴–10⁵ DPs | worker |
| exact allocation, `m = 4` | 10⁴–10⁵ DPs | worker |

Consequence: **editable target probability is fine.** Presets (90 / 75 / 50) are a UX nicety, not a compute crutch — keep the slider, offer the presets as buttons.

Write the math pure, measure, add the worker only when a bench says so. Memo key = canonical hash of `(N, sorted group counts, constraint vector)`. Cache the *curve*, not point values.

Cancellation: slider drags fire fast. Worker client must support superseding an in-flight request (req-id + drop stale responses), or you'll render the wrong curve.

---

## 8. Persistence & sharing

Versioned URL hash: `#v1.<base64url(compact JSON)>`.

- free sharing, free reload survival, no backend
- state lives in the hash → **no client-side router → no GitHub Pages 404/SPA-fallback problem at all**
- include a `v` field from commit #1. Migrating unversioned blobs later is misery.
- keep it compact: short keys, integer arrays, drop defaults

**Queries reference groups by stable `id`, not index.** Deleting or reordering a group must cascade into every saved query (drop the atom, or mark the query broken and tell the user). Getting this wrong corrupts saved links in a way that looks like a math bug.

---

## 9. Testing

The math is invisible-failure-prone; tests are not optional.

1. **BigInt exact-rational oracle** (`exact.ts`) — small `N` only, assert DP matches to 1e-12.
2. **Brute force**: enumerate all `C(N,n)` draws for `N ≤ 20`, `m ≤ 3`; count events directly; assert equality. Catches every DNF/I-E sign error.
3. **Properties** (fast-check):
   - `Σ pmf = 1`
   - for `≥`-only queries: `P` nondecreasing in `n` and in each `K_g` ← **this one guards the frontier pruning.** If it ever fails, `frontier.ts` is wrong, not the test.
   - `P(n = N) === 1` for satisfiable monotone queries
   - normalize is idempotent; `NOT NOT e ≡ e`
   - `atLeastK(1, kids) ≡ or(kids)`; `atLeastK(c, kids) ≡ and(kids)`
4. **Degenerate inputs**: `n=0`, `n>N`, `K=0`, `lo=0` (⇒ `P=1`), empty deck, `others=0`, single group = whole deck.
5. Spot-check a handful of numbers against deckulator, incl. verifying their "at least" is inclusive.
6. Display rounding: never print `100%` for `0.9994`, never `90%` for `0.8996`. Round-half-even at a fixed precision, one helper, used everywhere.

---

## 10. Milestones

1. **M0** — Vite+TS+vitest skeleton, CI green, empty Pages deploy live. Verify the URL works *before* writing features.
2. **M1** — `lnfact` + `hyper` + `boxdp` + oracle/brute-force tests. No UI.
3. **M2** — Deck editor: locked size, derived `others`, invalid-state banner.
4. **M3** — Single `≥` query → curve + table w/ `ΔP`. First useful build. Compare vs deckulator.
5. **M4** — `expr`/`normalize`/`evaluate`: AND/OR/NOT/atLeastK, intervals, I-E. Monotone detection flag.
6. **M5** — Grid view (heatmap + contours). Worker if benches demand.
7. **M6** — Frontier/tradeoff table + "draws needed for target%" + feasible-window reporting.
8. **M7** — Allocation optimizer (§5.2, §5.3). The differentiating feature.
9. **M8** — URL hash sharing, presets, polish, mobile.
10. **v2** — 3D surface, overlapping tags, mulligans.

Ship M4 publicly. Everything after is upside.

---

## 11. Deployment — GitHub Pages

### You do NOT need to touch your existing site
- `<user>.github.io` = **user site**, served at the domain root.
- A new repo `deck-calc` = **project site**, served at `https://<user>.github.io/deck-calc/`.

They're independent. No index editing, no merging. Optionally add one link from the user site to the new one — that's the only reason to touch it.

Caveat: if the user site has a **custom domain**, project sites inherit that apex → `https://yourdomain.com/deck-calc/`. Same path logic, different host.

### Vite config
```ts
base: '/deck-calc/'   // MUST match repo name exactly, leading+trailing slash
```
Wrong `base` = blank page + 404s on `/assets/*`, and it looks like a build failure. #1 Pages gotcha. Use relative asset paths or an env-driven base so `dev` and `preview` both work.

### Workflow
`.github/workflows/deploy.yml` — build on push to `main`, deploy via `actions/configure-pages` → `actions/upload-pages-artifact` → `actions/deploy-pages`. Needs:
```yaml
permissions: { contents: read, pages: write, id-token: write }
```
Then **Settings → Pages → Source = "GitHub Actions"** (one-time; may need to be flipped by hand, the API path for this is fussy).

No SPA fallback needed — state is in the hash (§8). If a router is ever added, copy `index.html` → `404.html` at build time.

### Token
- Classic PAT w/ `repo` + `workflow` scopes is the least painful for create-repo + push + workflow. Fine-grained tokens need repo-creation permission at the account level and are easy to under-scope.
- A token pasted into chat is exposed in conversation history and logs. Issue a short-lived one, and **revoke it when the setup session ends.**

---

## 12. Watch-outs (ranked by how badly they bite)

1. **Group disjointness.** Violate it → every number is wrong, nothing errors. Enforce in the model, assert in the DP.
2. **Turn ↔ `n` off-by-one.** Silently wrong, plausible-looking. Unit-test the table.
3. **Monotonicity assumed where it doesn't hold.** Frontier/binary-search code must be *unreachable* for non-monotone queries — enforce with a type-level flag on the normalized query, not an `if`.
4. **Group ids vs indices in saved queries.** Corrupts shared links; presents as a math bug.
5. **Clamping numeric inputs while typing.** Guaranteed rage.
6. **Vite `base` on Pages.** Blank white page, looks catastrophic, is one line.
7. **I-E cancellation.** Kahan-sum; assert pre-clamp bounds in dev.
8. **`2^c` blowup.** Cap clauses at 8, prune aggressively, warn in UI.
9. **Greedy allocation presented as exact.** Label heuristic results as heuristic.
10. **Stale worker responses** during slider drags → wrong chart, no error.
11. **plotly bundle size** if 3D lands eagerly in the main chunk. Lazy-load or defer to v2.
12. **Rounding display** inconsistency (100% that isn't 1.0).
13. **Mobile**: wide tables + heatmaps. Decide the small-screen story before building three grid views.
14. **Deckulator semantics drift** — confirm inclusive `≥` before trusting parity checks.

## 13. UI/UX watch-outs (deferred, tracked for the real build)

Math is the current focus; these are noted so they aren't lost, not because they're being solved now.

1. **Empty group name.** Renaming a group to `""` prints the query as `""` , which then fails to re-parse the moment the textarea is touched again. Needs the same "must be non-empty" validation already applied to the duplicate-name check.
2. **Focus/cursor preservation on re-render.** The `others` cell fix (in-place DOM update instead of a full table rebuild) is the pattern — any future re-render of a row containing a focused input must follow it, or typing gets interrupted mid-digit.
3. **Grid legibility on mobile.** The 2D heatmap already needs horizontal scroll on desktop; on a phone it may need a fundamentally different presentation (tap-to-inspect a cell instead of a dense table) rather than a shrunk version of the same grid.
4. **Grid recompute cost as it scales.** Currently synchronous and capped (12 copies × 20 draws). Fine now; once it's not capped, or once it runs per-keystroke on a large query, it needs the worker + stale-response cancellation from PLAN.md §7, or a slider drag will visibly lag or race.
5. **Turn column ambiguity.** "Turn 4" reads differently depending on on-the-play vs on-the-draw and drawsPerTurn — once this leaves the harness, the axis label must always say which convention is active, not just expose it as a toggle elsewhere on the page.
6. **Non-monotone results need a different visual grammar**, not just different text. A single "draws needed" number is the wrong shape for a result that's a bounded window with a peak — the real UI should probably show the window/peak on the curve itself (shading, a marker), not only in a sentence.
7. **Rounding at display boundaries.** `99.6%` must never render as `100%`, and `90.04%` must never render as `90%` when the target is exactly 90 — both are already handled by fixed-precision truncation in the harness, but re-verify wherever formatting gets rewritten.
8b. **[Resolved]** Deleting a referenced group surfaced a correct but dead-end error with no
    recovery path and no memory of the group's name. Fixed: the harness now remembers a
    deleted group's last name (`ghostNames`) so the message says which group is gone, and
    offers a one-click "Remove from query" action backed by `pruneGroups` (`src/math/expr.ts`)
    — an explicit, tested AST rewrite (DEAD-sentinel propagation so AND/OR/atLeastK each use
    their own identity) rather than a silent drop.
9b. **[Added]** Structured query builder (`src/math/builder.ts` + harness wiring): a flat
    picker (group / comparator / number, joined by AND / OR / at-least-N) that writes valid
    query text on every change, so the fragile hand-typed syntax is opt-in rather than the
    only path. `decompileFlat` mirrors state.ast back into the picker when possible and
    otherwise says so, rather than guessing. Caught two real bugs this way: (1) a stale
    "unavailable" builder kept rendering old rows because the render function checked
    `!state.builder` before the unavailable flag; (2) a range condition (`lo>0` and `hi<K`)
    has no single-token text form, so it prints as `G>=lo & G<=hi` — round-tripping that back
    through the parser produces a genuine two-atom AND, which `decompileFlat` didn't
    originally recognize as "the same row" and incorrectly called the query too complex.
    Both are covered by regression tests (`builder.test.ts`).
10. **Query text vs AST divergence on parse errors.** While `state.queryError` is set, the textarea shows whatever the user typed, which may no longer match `state.ast`. That's correct (don't overwrite what they're typing), but the eventual UI should make clear *which* result is being shown — the last-valid one — so it doesn't read as if the broken text produced it.
