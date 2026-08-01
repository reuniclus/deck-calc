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

### 3b2. [Fixed] Grid rows hardcoded to 0..12, ignoring the actual count

The 2D grid's row range was `k = 0..min(deckSpace, 12)` unconditionally — fine when
group counts are small, silently wrong once a count exceeds 12 (e.g. A=37 in a
99-card deck): every displayed row was between 0 and 12 copies, nowhere near the
actual 37, so the "current deck" marker never appeared and every cell showed a
near-zero probability that had nothing to do with the real composition — while the
per-draw table, using the real count directly, was correct. Fixed by centering a
fixed-size window (12 rows) on the actual count instead of always starting at 0,
sliding to stay within [0, physical max] near either edge, so the real composition
is always inside the visible window. `curves` changed from an array indexed 0..kMax
to a `Map<number, curve>` keyed by absolute copy count, since the window no longer
starts at index 0. Verified: A=37/deck=99 now shows rows 31..43 (was 0..12) with a
value matching the math layer directly (23.35% at n=7); edge cases confirmed at both
the physical maximum (window slides down, still includes the cap) and near zero
(clamps at 0, no negative rows).

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

### 4d. Export / import

A textarea + Export/Copy/Import buttons in the harness, covering exactly deck size,
groups, copies, and the query — not target %, turns, or grid display settings (those
are session/view preferences, not "the deck," and mixing them in would make an
exported blob subtly different every time you'd changed an unrelated display
toggle). Format is plain single-line JSON (`{v, deckSize, groups:[{name,count}],
query}`), chosen over base64 for transparency — it's meant to be pasteable into a
chat or notes file and glanced at, not treated as an opaque token.

Groups get FRESH ids on import, never the exporter's ids. The query travels as TEXT,
and import re-parses it through the normal name-based resolver — the exact same path
a hand-typed query takes — so it reconnects to the new ids automatically with no
special-casing. This is the same principle as renaming a group (PLAN.md §8): ids are
the internal source of truth, text is what crosses any boundary (clipboard, and
later, a URL).

Import validates structurally (deckSize positive, count non-negative, groups an
array, query a string) before touching state, with one message per failure. It does
NOT pre-validate that the query resolves — a query naming a group absent from the
import fails through the ordinary parse-error path afterward, same as typing it by
hand, rather than being special-cased. Verified: duplicate imported names correctly
trigger the existing dupe-name banner (no new codepath needed); a bad query doesn't
prevent the deck/groups from being applied.

Clipboard copy uses the async Clipboard API with a fallback (select the textarea +
prompt for manual Ctrl+C) since `navigator.clipboard` isn't guaranteed available in
every context (e.g. some sandboxed or file:// origins) — confirmed the fallback path
itself in a headless environment with no real clipboard.

### 4e. "Path to target" advisor + a real frontier.ts bug it exposed

Added a "by turn" input (separate from target %) driving the Tradeoffs panel, which
now presents two genuine alternatives to the same goal: (A) keep today's deck and
draw longer (`analyze()`'s existing `drawsNeeded`, already computed) vs. (B) keep
the turn fixed and change the deck (`minimalVectors` at that fixed n). Previously
this panel evaluated `minimalVectors` at `n = drawsNeeded` — circular, since by
definition the current deck already meets target exactly there, so it could only
ever report "0 more copies needed." Turn is now a free variable, which immediately
exposed two real, pre-existing bugs in `frontier.ts` (not new code — they'd been
there since §5's original build, just never exercised by a test case where the
search ceiling actually mattered):

1. **The search ceiling was bound to the query's current group size, not deck
   capacity.** An unbounded atom like `A>=1` normalizes to `hi = K` (the group's
   CURRENT count) — correct for evaluating probability, wrong as a search ceiling:
   it made it structurally impossible to ever suggest running *more* copies than
   already in the deck. Fixed at the call site: build a separate search box with
   `hi = N` before handing off to `minimalVectors`/`allocate`/`minSlotsForTarget`;
   each function's own accounting (other groups' minimums, N itself) tightens it
   further from there.

2. **`minimalVectors`'s "descend from the maximal corner" approach breaks the
   moment a budget constraint (`kSum <= N`) cross-cuts the search box** — e.g.
   `(K_a=20,K_b=5)` and `(K_a=5,K_b=20)` can both be feasible with neither
   dominating the other, so no single corner's descent reaches the whole feasible
   region. The old code's corner (each group at its own unconstrained max) usually
   violated the budget outright and the function just gave up, reporting
   "unreachable" for queries that were very reachable. Replaced with a genuine 2D
   staircase walk (the O(range) algorithm PLAN.md originally described, never
   actually implemented) over the last two free groups, with any additional groups
   fixed via a bounded outer loop (`OUTER_CAP`) for m=3/4. `bestP` also no longer
   checks only "one group maxed, rest at minimum" corners (which found only 25%
   when the true balanced optimum was 99.96%) — it now reuses `allocate.ts`'s
   already-tested exact/greedy solver directly rather than re-deriving the same
   optimization worse.

Caught mid-session by dogfooding the new feature immediately, not by pre-existing
tests — none of the original test cases had `hi` large enough relative to `N` for
the budget to actually bind, which is exactly why 10/10 passed while the bug was
live. Added cases that specifically stress the budget boundary (`hi` close to `N`,
2/3/4 groups) verified against brute force, plus one hand-verified-by-exhaustive-
search 4-group case pinning that `allocate()`'s greedy heuristic found the true
optimum for that instance specifically (m=4 remains a heuristic in general, per
§5.2 — this only confirms one case, not the heuristic's general behavior).

### 4e. "Path to target" bidirectional advisor, and a real bug it exposed

Added a "by turn" input, separate from target %, so the Tradeoffs panel can compare
two genuinely different paths to the same goal at a FIXED, chosen turn — instead of
evaluating everything at n=drawsNeeded, which is circular (at that exact n your
current deck already succeeds by definition, so "how many more copies do you need"
trivially always answered zero). Now: "draw longer with today's deck" (reusing
analyze()'s existing drawsNeeded) and "keep this turn, change the deck instead"
(minimalVectors at the fixed n) are shown side by side as real alternatives.

This surfaced two compounding bugs in `frontier.ts`'s `minimalVectors`, both
invisible before because nothing had ever called it at an n where the search
space's budget constraint (`kSum <= N`) actually bound:

1. The search started its greedy descent from an unconditional "max corner" (each
   group at its own independent max, ignoring the others) — which can trivially
   violate `kSum <= N` on its own (e.g. two groups each maxed at 39 in a 40-card
   deck sum to 78). When that starting corner was infeasible, the function gave up
   and reported the target as unreachable, even when it plainly wasn't (real answer:
   9/10 split, 99%+). Worse, no single corner CAN dominate the whole feasible
   region once a budget cuts across the box — (20,5) and (5,20) can both be
   feasible with neither dominating the other — so "pick a better single corner"
   isn't a fix either. Replaced with a genuine 2D staircase walk (the O(range)
   algorithm this file's own docstring always claimed, but never actually had):
   for two free groups, walk one axis while the other's minimal-reaching value
   only ever decreases (guaranteed by joint monotonicity), re-clamping to the
   shrinking budget ceiling every step — the second bug was forgetting that
   re-clamp, which let a stale, budget-violating value get permanently stuck.
   Three or four groups: fix the extra ones via a bounded outer loop (cap
   20,000 combinations), staircase the last two.
2. `bestP` was computed by checking only "one group maxed, the rest at their bare
   minimum" corners — missing that the true optimum is usually a BALANCE (20/20
   beats 39/1 or 1/39 in the case above, 99.96% vs 25%). Fixed by reusing
   `allocate.ts`'s already-correct, already-tested budget solver instead of
   re-deriving the same optimization inconsistently in a second place.

Verified against brute force at N up to 40 for 2 groups and N=18 for 3–4 groups,
including cases specifically chosen so the budget binds (every prior test case
had `hi` small enough relative to `N` that it never did — which is exactly why
this shipped and stayed broken until a real "add copies at a fixed, earlier turn"
question finally exercised it). 141 tests total (was 134).

Also fixed the same root cause one layer up: `renderFrontier`/`renderAllocation`
in the harness were passing the query's OWN box straight through, whose `hi` per
group is bounded by that group's CURRENT count (an unbounded atom like "A>=1"
normalizes to `hi=K`) — correct for evaluating probability, wrong as a search
ceiling, since it made it structurally impossible to ever suggest running MORE
copies than you already have. The harness now builds a separate search box with
`hi=N` (deck capacity) before calling into `frontier.ts`/`allocate.ts`, leaving the
original query box untouched for actual probability evaluation elsewhere.

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

## Backlog: "frequently asked" deck-builder questions (2026-07-29 discussion)

Almost everything raised reduces to two primitives, plus one shared prerequisite:

**Primitive A — condition on a hypothetical hand/reveal, project forward.**
Given query Q, a hypothetical composition already seen (e.g. "2 lands in a 7-card
hand"), and N more cards to come: what's P(Q) after those N draws (or the whole
curve as N varies)? This is exactly `keepValue`/`keepCurve` from `mulligan.ts`,
generalized to be invoked directly rather than only as one branch of a
keep-vs-mulligan comparison. Covers:
  - "Is my N-land hand safe to keep" (the literal ask)
  - Draw X: same primitive, N shifted forward by X. Trivial, no new math.
  - Scry X: **reduces to the same primitive too**, via a real derivation, not a
    hand-wave -- for a monotone query, optimal scrying is "keep every useful
    card on top, bury the rest," which makes "how many of group G will I have
    after scrying X then drawing n more" identical to conditioning on an X-card
    reveal. One real caveat: the equivalence only holds exactly for n>=X --
    below that, the effective shift is `min(X,n)` at each point along the
    curve, the same kind of per-point variation the mulligan curve already
    needed (see `optimalMulliganCurve`'s extraDraws indexing).

**Primitive B — fewest copies for a target.** Already built: `allocate.ts` /
`minSlotsForTarget`. "How many dark monsters", "how many WUG sources" (assuming
non-overlapping sources) are already fully answerable today with zero new code
-- confirmed with real numbers: 16 copies of a single group for 90% by opening
hand in 60 cards; W:11/U:10/G:10 (31 total) for 85% by turn 3 in 40 cards with
NO overlap allowed (illustrates why real manabases need dual lands -- the
non-overlapping answer is mathematically correct but unrealistically
expensive).

**Shared prerequisite: overlapping/multi-role sources.** Both primitives above
assume every card serves exactly one role. The moment a card can satisfy more
than one (MDFC, dual land, flexible spell, "exile A or B from hand"), both need
the same fix -- one shared piece of work, not three separate ones. Manual
tagging ("this group also counts as that group") should come before any
Scryfall-driven auto-classification, since auto-deriving "what colors does this
land produce" from oracle text is unreliable for the full card pool (basics/
simple duals are easy; conditional lands and "choose a color" effects are not)
and will always need a manual-override path anyway.

**Tapped lands -- reduces to an existing shape, not a new primitive.** Optimal
play is "hold back your one untapped land for the turn you need it" -- you're
only hurt if EVERY land drawn by a given turn is tapped. So the base version is
just a plain two-group query: `P(Untapped=0 & Tapped>=T)`. Refined per the
2026-07-29 discussion: the turns that actually matter are only the deck's own
mana-curve STEP-UP points (where needed mana increases turn-over-turn), not
every turn -- a deck with no 1-drops needs nothing on turn 1, so a tapped land
there is free. Checking each step-up turn INDEPENDENTLY is a stated, named
heuristic (not the exact joint "never blocked across the whole game"
probability, which is a genuine cumulative/path-dependent condition -- same
flavor of hardness the mulligan model needed, not a free extension).

**Mana curve vs. landbase, as full distributions (not fixed curves).** Both
"mana needed by turn T" and "mana available by turn T" are themselves random
(hypergeometric) -- not fixed numbers derivable from the decklist alone.
Comparing the two distributions independently per turn (e.g. P(available >= X)
vs. P(you've drawn something costing X)) is cheap and exact on its own, and is
the NEAR-TERM scope. The exact JOINT version -- optimal sequencing of which
spells to cast turn over turn, maximizing mana spent (the "spend the most mana
usually wins" heuristic), given hand composition is itself a random Markov
chain -- is a substantially bigger, separate project:
  - State reduction: track hand composition by cost-bucket counts (not exact
    cards), same reduction used for groups everywhere else in this project.
  - Per turn: a bounded knapsack (which subset of in-hand spells to cast to
    minimize wasted mana this turn) -- exactly solvable, not guessable.
    Confirmed "cheapest-castable-first" is PROVABLY SUBOPTIMAL (concrete
    counter-example: 4 mana available, spells costing 2/3/4 plus a land in
    hand -- greedy cheapest-first wastes 4 mana total across two turns, optimal
    sequencing wastes 0).
  - Across turns: solve backward as an MDP, expected value over the
    hypergeometric distribution of what's drawn next at each state.
  - Monte Carlo is the correct fallback ONLY if the exact DP's state space
    actually blows up for realistic parameters -- this project has
    consistently avoided simulation elsewhere because the exact version turned
    out tractable once redundant work was memoized (see mulligan.ts's own
    history); don't reach for simulation preemptively.
  - Scope: comparable in size to mulligan.ts, likely larger given the
    multi-turn horizon and per-turn knapsack. Not blocking anything above.

**UI direction (agreed, not yet built):** a dedicated "Questions" tab, separate
from Suggestions (these are often orthogonal to the current combo query, not
extensions of it). Each frequent question is a PRESET over one of the two
generic engines (a small form with blanks: hypothetical-hand count, group
picker, target %, turn) rather than a bespoke widget per question. Deck size /
hand size auto-filled from the rail unconditionally; group-to-role mapping
(e.g. "which of your groups is Untapped vs Tapped") always an explicit picker,
never silently assumed. Live-updating, no submit button, matching the rest of
the app.

### Refinements to the above, 2026-07-30 mockup review

- **"Is my hand safe" isn't a single scenario, it's a table.** Own standalone
  single-condition query ("I need X of A by turn T"), decoupled from whatever
  the main combo builder currently has (which might have an OR/NOT that
  doesn't make sense for a quick single-resource check). Output is every
  possible opening-hand count (0, 1, 2, ...) as a row: keepP vs mulliganP vs
  verdict -- literally `mulligan.ts`'s existing per-hand strategy table,
  scoped to one group's axis, not a new computation.

- **Draw/scry merges into "how many cantrips should I run" -- a genuinely
  different, harder question than either alone**, needing a stated scope:
  each drawn cantrip contributes its bonus looks (M-1 for a "look M, keep
  best" effect) independently; NOT modeled: a cantrip's own reveal chaining
  into casting another cantrip (real value is somewhat higher than this
  computes). Tractable because "how many cantrips drawn by turn T" is itself
  hypergeometric, so it's a weighted sum across "drew 0 / drew 1 / drew 2..."
  scenarios, each a known shift on the existing curve machinery. Full exact
  modeling of cascading is comparable in scope to the mana-curve MDP already
  parked -- not attempted here. Headline output is a table (N cantrips -> P%,
  delta); secondary metrics (avg cards seen, P% conditional on having drawn a
  cantrip, distribution of what a look actually contains) belong under a
  "more details" disclosure, not the main view.

- **"Enough setup for my payoffs" (Allure of Darkness / dark monsters) is a
  genuinely NEW query shape, but not new hard math.** Different from Primitive
  B ("copies vs a fixed threshold"): this is "copies of a consumed RESOURCE
  vs. copies of the PAYOFF that consumes it," i.e. P(darks drawn >= Allures
  drawn) -- answerable directly from the same joint multivariate distribution
  mulligan.ts already computes elsewhere (sum joint probability over every
  (a,d) pair where d>=a). Worth generalizing Primitive B's family to cover
  "resource vs. another random count from the same deck," not just "resource
  vs. a fixed number."

- **Tapped-land damage as a distribution, not one number** -- same
  `P(Untapped=0 & Tapped>=T)` computation, shown across every turn AND across
  "how many untapped would make you feel safe" (not just needing exactly 1).
  Presentation change on top of existing math, not new math.

- **Cantrips in a FIXED-size deck have a real critical mass -- deck dilution
  was missing from the model above.** Every cantrip added has to come from
  somewhere. Two regimes: replacing "Others" (filler, already a derived count
  the app tracks) is close to free digging power; once Others is exhausted,
  further cantrips must replace the QUERIED resource itself (lands, combo
  pieces), which directly lowers the base draw rate even while raising
  digging power -- net effect can go either way per copy, producing a real
  peak. No new hard math needed, and no extra "wasted look" penalty either --
  an earlier draft of this plan proposed scaling each cantrip's yield by deck-
  wide cantrip density to force a peak before Others ran out; numerically
  tested directly and confirmed UNNECESSARY. The straightforward model
  already produces a real, sharp peak exactly where dilution reaches the
  actual resource, with no fudge factor:
    1. For a given cantrip count N: cut from filler first, then from the
       resource itself once filler is exhausted (this determines the diluted
       resource count at each N).
    2. P(exactly k cantrips drawn by turn T) -- plain hypergeometric on the
       cantrip group.
    3. Weighted sum over k of P(k) * curve[cards-seen-by-T + k*bonus], using
       the DILUTED curve for that N (bonus = M-1 for a "look M, keep 1"
       effect).
  Confirmed with real numbers on a 40-card deck, 8-copy wincon, 12 filler
  slots: 0->12 cantrips (filler only) rises smoothly 89.7%->97.6%; past 12
  (now cutting the wincon itself) it falls sharply -- 94.9% -> 87.8% -> 67.4%
  by 18 cantrips. The peak IS the critical mass answer, and it can land much
  earlier than the deck's total filler count once the "Others" pool itself
  is small (matches the concern that with only a couple tracked groups, real
  decks often exhaust filler well under 20-30 cantrips). Full sequential
  treatment (exact composition at the precise moment each cantrip resolves,
  true cascading) stays parked as a separate, larger project -- this
  turn-by-turn weighted model is exact within its own two stated
  simplifications (no cascading; flat per-cantrip bonus), not a new
  approximation layered on top. UI should show WHERE cantrips start cutting
  into the real resource, not just the resulting numbers, and should
  headline "success rate given you've actually drawn a cantrip vs. given you
  haven't" as its own stat, not buried under "more details" -- that gap is
  most of a cantrip's real value.

### Rail: per-group count/target toggle (SUPERSEDED, see revision below)

[Original mode-toggle design kept for history -- replaced after review found
it both over-explained (a written "space available" note for arithmetic the
Others row already shows) and under-communicated (a bare #/% switch doesn't
convey which mode means what without a label).]

Each group row gets a switch: "by count" (today's behavior) or "by target %"
(type a target success rate, the tool solves for the count). Multiple groups
CAN be in target mode simultaneously -- deliberately not mutually exclusive.
[...conflict handling via a red input + written note, see git history...]

### Rail: count + % always both visible, no toggle (SETTLED, 2026-07-30 revision)

No mode switch. Every group row shows BOTH numbers at once, always, live:
the hard count (plain bordered input) and the resulting success % by the
current goal turn (dashed-underline input, reusing the SAME visual style the
advisor strip's own goal inputs already use elsewhere in this app -- "this is
a target" is conveyed by an EXISTING pattern, not a new label or word).
Editing either one recomputes the other; nothing needs a label to say which
field means what, because the styling difference already carries that
meaning consistently across the app.

Zero explanatory text anywhere in the row. The conflict case (typed % isn't
reachable given what other groups currently hold) is conveyed the same way
running out of room already reads elsewhere: the count silently caps at the
max the remaining space allows, the % field shows the ACTUAL resulting rate
(not the impossible ask), and the Others row -- already visible, no new UI --
reaching 0 IS the "no more room" signal. No red text, no written note. A
brief shake on Others when a further push is attempted was raised as an
optional micro-interaction, explicitly not required for the design to be
self-explanatory.

Same underlying independent-solve semantics as the superseded toggle design
(each row solves against every OTHER group's CURRENT count, not jointly;
recomputes live on any change; not a simultaneous solver). Global/joint mode
(`minSlotsForTarget`, already built, not yet surfaced in the rail) remains
deferred for the same reason as before -- it's the one that can quietly ask
for more total cards than the deck has room for once several independent
targets overlap, which needs the multi-role-card primitive first.

Each row's % is labeled, in small muted text, "in opening hand" -- and is
computed against the rail's OWN hand-size setting, not the advisor strip's
turn-T goal, deliberately. Keeps the row self-contained: changing T elsewhere
in the app must not silently change what these numbers mean without the row
itself saying so. If a by-turn-T version is wanted later, it should say so
explicitly in the same muted style, not share a meaning with a setting that
lives somewhere else on the page.

### Further Questions-tab revisions, 2026-07-30 (second mockup review)

- **"How many copies do I need" dropped from Questions entirely** -- redundant
  with Suggestions' existing "fewest slots for target," no reason to duplicate it.

- **"Is my hand safe" needs no new code at all.** Uses the REAL combo query
  (not a separate standalone mini-query), and the table is multi-column for
  multi-group queries -- which means it's exactly `mulligan.ts`'s existing
  per-hand strategy table (`optimalMulliganStrategy`'s `strategy` rows),
  already rendering in the Suggestions tab. Extract that table into its own
  reusable component and render it in BOTH tabs against the same shared
  computation (`useMulliganStrategyCtx()`) -- do not build a second version
  of the same math. Mulligan count comes from the rail's existing "Mull."
  setting, same pattern as "in opening hand" pulling Hand size rather than
  asking for it again.

- **Tapped-land damage: simplified inputs, no group pickers needed.**
  "`_` lands, `_` tapped" (two plain numbers) instead of picking Untapped/
  Tapped as separate tracked groups -- Untapped is derived as
  lands-minus-tapped internally, so this doesn't depend on the rail having
  those groups pre-configured at all. Also: no turn cap input -- show the
  full table until risk is negligible, don't artificially stop at a chosen T.
  The mana-curve-aware "only check step-up turns" refinement from the first
  mockup review is NOT implemented this round (would need cost-tracking per
  card, which doesn't exist in the app's data model at all today) -- showing
  every turn is the deliberate, smaller-scope version for now.

- **Cantrips as a DISTRIBUTION of look-sizes, not one uniform M -- a real
  generalization of the math, not just a UI change.** Input becomes a small
  add/removable list of (count, look-size) pairs (e.g. "6 that see 3, 1 that
  sees 4, 1 that sees 6"), not a single "N cantrips, each looks at M" pair.
  This turns "how many cantrips drawn by turn T" from a single hypergeometric
  variable into a JOINT one -- how many of EACH distinct look-size got drawn
  by turn T, simultaneously -- the same kind of multivariate distribution
  mulligan.ts already computes for hand compositions (enumerateHands-style),
  just applied to "which cantrip types you've drawn" instead of "which
  resources." Tractable with existing techniques, not a new kind of hardness,
  but a genuine step up in scope from the single-M version. Dilution still
  applies across the combined total (every distinct look-size is its own
  deck slot competing for the same shrinking Others pool) -- not modeled
  separately per look-size type, stated explicitly in the UI's scope note.

### Cantrip card, third revision: stop prescribing, start informing (2026-07-30)

Real problem with "suggest the best combination" left to run freely: it will
always favor the biggest look-size (5>4>3...), but bigger effects aren't
always available or feasible for reasons the tool can't see (mana cost,
color, card availability, format legality). Prescribing a single "optimal"
mix is fighting the model's own honesty, not fixing a bug in it.

Fix: don't prescribe, INFORM. Flip the question per effect type: "what does
+1 copy of THIS do to my success rate, right now" -- a marginal value, not a
recommendation. The decision of which effects to actually run stays with the
user, who knows constraints the tool doesn't.

Marginal value is a snapshot, not a constant: it depends on everything else
currently in the deck (dilution), so it recomputes live as the rest of the
deck changes, same as everything else in this app -- never implies a
universal ranking.

Showing the full declining-marginal-value curve (0->1, 1->2, 1->3, ...) is
too much information for a quick nudge, given real decks run at most 4 (rarely
8) copies of anything. Collapse to ONE approximate number per effect type:
the AVERAGE marginal value over a realistic 1-4 copies, prefixed with "~" to
honestly signal it's an approximation, not any one specific copy's exact
value. This telescopes cleanly: average of the four step-wise marginals
(0->1, 1->2, 2->3, 3->4) equals (P(4)-P(0))/4 exactly -- one evaluation, not
four, confirmed algebraically and numerically before relying on it.

"Suggest a combination for target X%" is a separate, EXACT feature, not an
extension of the ~ estimates -- a real multi-dimensional search across
several effect types at once (see the earlier A/B split: ratio-preserving
scale-up now, real per-card copy-cap allocation later). Presenting a single
suggested combination doesn't reintroduce the "always picks biggest" problem
here, since the search is happening across TYPES the user already chose to
include, not silently picking which types matter.

The suggested (or manually built) mix should be directly checkable via the
SAME exact tool used to build one by hand -- suggestions aren't a black box,
they hand off to the same verify-a-specific-mix interface a person would use
themselves, matching "don't build the same computation twice."

UI: default/primary view is JUST the per-type ~ marginal list plus the
"suggest a combination" action -- both cheap to read, neither requires
opening anything. The full manual distribution editor (add/remove
(count, look-size) rows), the detailed cantrips-vs-success table, and the
"more details" sub-metrics are ALL collapsed under a single disclosure by
default, layered (a nested "more details" inside the outer "build an exact
mix" disclosure) rather than all flattened into one view -- keeps the
common case to two things to read, the power-user case fully available one
click away.

Global target% possibly belongs in the rail rather than re-entered per
Questions card, since `target`/`adviseTurn` are ALREADY single shared values
in the app's data model (the advisor strip is just the one current place
that edits them) -- Questions cards defaulting to that same shared value
is consistency with how Hand size and Mull are already reused, not new
state. Whether its UI home physically moves into the rail is a separate,
smaller layout decision not resolved yet.

### Fourth mockup pass: cut the notes, cut a dead table (2026-07-30)

- **Per-card "uses current settings" reassurance text consolidated to ONE
  tab-level line**, shown once under the Questions tab strip, not repeated
  per card -- every other tab already updates live without saying so per
  card; Questions gets exactly one line acknowledging that, not several.

- **The "~ averaged over 1-4 copies" caveat moved from a paragraph into a
  tooltip on the "~ value per copy" column header** -- the explanation only
  needs to exist once, attached to the thing it explains, not sitting in the
  main reading flow as its own line.

- **Removed the "total cantrips -> success/gain/cutting-from" table
  entirely.** It implied a single scalar "total count" was the interesting
  variable, but the real answer is always "fill all filler with cantrips"
  once dilution is understood -- the table didn't tell you WHICH cantrips
  were being added, just an abstract total. What actually matters -- a
  specific, named mix and its real result -- is exactly what "build and test
  an exact mix" already gives; the table was redundant sanity-checking on
  top of a tool that already IS the sanity check.

- **"More details" flattened, not nested inside a second disclosure** -- it
  now sits as a plain section alongside the mix builder inside ONE
  "build and test an exact mix" disclosure, not a details-inside-a-details.
  Its metrics (avg cards seen, look-composition breakdown) are computed FROM
  whatever mix is currently entered in that same disclosure, not a separate
  hypothetical -- one mix, one set of numbers describing it.

- **Tapped-land damage REMOVED from this round entirely**, not just
  simplified further. The turn-by-turn percentage table reads too
  abstractly on its own to be useful as shipped. Needs a real design
  rethink before returning: likely comparing directly against the deck's
  actual mana curve (a graph, not a table of percentages), or suggesting a
  landbase shape that fits the curve, rather than a bare risk-by-turn list.
  Left as an open, unscoped problem -- not scheduled, not designed further,
  parked exactly where the cascading-cantrips and mana-curve-MDP problems
  already are in this document.

### Fifth mockup pass (2026-07-30)

- "Same table as Suggestions" note removed -- didn't need explaining.
- "Uses your current settings live" note removed ENTIRELY, not relocated.
  It's true for every tab already, and none of them say so; adding it only
  for Questions would be the one inconsistent thing on the page.
- Cantrip table's "suggest a combination" button removed. Replaced with a
  live third column, "copies for [target]%", computed directly per effect
  type (a single-group minSlotsForTarget-style solve per row) -- no click
  needed, and genuinely plural (one independent suggestion per row) rather
  than one prescribed mix. The old explanatory sentence ("exact search, not
  the ~ estimates above") is no longer needed once the column sits directly
  next to the ~ column it's contrasted with.
- "When you've actually drawn one..." reworded to "With a cantrip drawn:
  92%. Without: 62%." -- same numbers, shorter.
- The 3-card-look composition breakdown moved OUT of the "build and test an
  exact mix" disclosure, now sits directly under the top-level marginal
  table (a fact about the deck generally, not specific to any one mix).
- **"Enough setup for my payoffs" redesigned to read counts from the rail
  instead of asking again.** Real problem identified: it was awkwardly
  mixing "pick a group" (rail-driven) with "manually type how many copies"
  (duplicate of what the rail's count/% row already tracks) -- and risked
  its own trial-and-error hunting for the right dark-monster count. Fix:
  drop the manual copy-count input entirely; it's just two group pickers +
  a turn now, with counts read live from whatever the rail currently shows
  for each picked group (same reuse principle as "is my hand safe" using
  the real combo query instead of a separate mini-query). Added a direct
  "darks needed for 90%" readout, same live-third-column idea as the
  cantrip table, so reaching a target doesn't require manually walking the
  rail's count up and down first.
- A "lookup table / cheat sheet across multiple payoff-count values" was
  raised as a nicer possible presentation but is a genuinely open design
  problem given how arbitrary the underlying query can be -- parked
  unscoped, same status as tapped-lands and the cascading-cantrips model,
  not designed further this round.

### Shared goal across Questions cards (2026-07-30)

Confirmed: the cantrip table's "copies needed" column and the payoffs card's
"needed for X%" line share ONE global target -- not independent per-card
inputs. Since target% and turn T are already one combined "Goal" unit in the
advisor strip (not two separate settings), both are shared together, not
just P% alone -- sharing one but leaving the other per-card would reintroduce
the exact inconsistency just eliminated elsewhere in this tab.

Visual treatment: wherever the shared value appears in a Questions card, it
uses the SAME dashed-underline accent-colored style as the rail's goal
inputs and the advisor strip -- signals "this is the same value as
everywhere else in the app" without needing a word of explanation, matching
how the rail redesign already solved this exact "how do I convey `this
number means something specific' without a label" problem. Editable from
any of these spots; changes propagate everywhere, since it's one value, not
several copies of it.

### Correction: cantrip exact-mix result needs the overall number, not just with/without (2026-07-30)

Trimming "when you've actually drawn one..." down to just "with/without"
went too far -- it lost the one thing the removed total-cantrips table WAS
good for: the overall, weighted success rate for the specific mix actually
built (combining "drew 0 cantrips," "drew 1," "drew 2," etc., weighted by
their real probabilities). Restored as the headline number, with the
with/without conditional breakdown kept underneath as supporting context
for WHY it works, not as a replacement for the overall answer.

### Payoffs card reframed: liveness across the whole game, not a single-turn snapshot (2026-07-30)

Real reframe, not just wording: the useful question isn't "at exactly turn T,
is Allure live" (a single snapshot), it's "how live is this card across the
whole game up to T" -- since when you'd actually want to cast it isn't pinned
to one instant.

Headline ("X% chance Allure is live") is an EQUAL-WEIGHTED AVERAGE of
P(darks drawn >= Allures drawn) across every turn from the opening hand
through the shared goal turn T -- not a snapshot at T alone. No separate
per-card turn input needed at all now, matching the earlier decision that
target%/turn are shared global values -- this card reads T directly rather
than asking for it a second time.

Secondary table (not the headline) gives the per-turn breakdown: for each
turn from opening hand through T, the dark-monster count needed to hit the
shared target% AT THAT SPECIFIC TURN (same inverse-solve idea as the cantrip
table's "copies needed" column, one row per turn instead of one row per
effect). Capped at the shared goal turn T, deliberately unlike tapped-lands'
uncapped table -- "darks needed" only grows as more turns/Allures pass, with
no natural "risk becomes negligible" stopping point the way tapped-land risk
has, so T itself is the natural, meaningful cutoff here.

### Two more trims (2026-07-30)

- Payoffs card's "averaged from opening hand through turn T, using your
  current counts" line removed -- same redundancy already eliminated
  elsewhere: T is visible in the advisor strip, both group counts are
  visible in the rail, restating them here added nothing.
- Cantrip result now shows the vs-zero-cantrips baseline too ("85% overall
  with this mix, vs 58% running none"), and the two comparisons (vs-zero,
  and with/without-drawn-by-T) are DELIBERATELY KEPT AS DISTINCT NUMBERS,
  not conflated -- "success with 0 cantrips in the deck" (undiluted) and
  "success conditional on not having drawn one yet" (diluted -- the
  cantrips are still occupying deck slots even in the branch where you
  didn't draw one) are genuinely different quantities and will not usually
  match; an earlier mockup draft accidentally used the same placeholder
  number for both, which would have implied a false equivalence.

### Final trim on the cantrip result line (2026-07-30)

Settled wording: "85% success rate by turn T, vs 60% running none." as the
headline, with just "92% if seen in opening hand." underneath in muted text
-- dropped the "62% if not by turn T" half of the conditional breakdown
entirely, and switched from the more abstract "drawn by turn T" framing to
the concrete, fixed "seen in opening hand" scenario, which needs no turn
reasoning to understand at a glance.

### Cantrip table header consolidation (2026-07-30)

Removed the separate "copies needed to reach X%:" line above the table --
folded directly into the third column's own header, "copies needed for X%
success," with the shared-goal input embedded inline. Verified directly
(not assumed) that this doesn't overflow even at 390px mobile width, the
tightest case in the app.

### Cantrips: implemented (2026-07-30), including a real bug caught only by real-browser verification

Built exactly to the settled design: `cantrips.ts` (dilutedResourceCount,
cantripSuccessRate as the joint multi-effect model, marginalValuePerCopy
telescoping to (P(4)-P(0))/4, copiesNeededForTarget, successGivenDrawnVsNot)
plus CantripsCard.tsx wiring it into the Questions tab. The open design
question from earlier -- which group absorbs dilution when a query
references several -- resolved as an explicit dropdown, never assumed.

Cross-validated against an independent brute-force computation for two
simultaneous effect types, and against the exact numerically-confirmed
dilution curve from the original design discussion (now a permanent test
instead of a one-off script result).

**Real bug, caught only by the real-browser verification pass, not by any
jsdom test beforehand:** `effectiveN = cardsSeenByT + k*bonus` can be a
non-integer once the UI pools several effect types into one average-bonus
summary stat for the "with one drawn vs without" conditional (e.g.
(6*3+1*4)/7 = 3.142857...). Indexing a Float64Array with a non-integer
silently returns `undefined` in JS -- confirmed directly -- and the existing
`?? 0` fallback (there for a different, legitimate reason: an out-of-range
index) turned that into a WRONG near-zero result rather than a visible
error. Measured impact before the fix: "68% if drawn" was actually showing
"0%", and worse, the "given drawn" conditional was coming out LOWER than
"given not drawn" -- backwards for a monotone query, which is what made it
visually obvious something was wrong during verification rather than a
subtle off-by-a-little value. Fixed with Math.round() at every curve-index
site in cantrips.ts. All prior tests used integer bonus values exclusively
and could not have caught this -- added two dedicated regression tests
using the exact non-integer bonus value that exposed it, one for each
affected function (cantripSuccessRate's joint path, successGivenDrawnVsNot).

Lesson worth generalizing (see CLAUDE.md): whenever a "curve" (Float64Array
indexed by cards-seen) gets indexed by a value derived from an average,
ratio, or other non-count-like arithmetic -- not just a raw draw count --
check whether that value can be non-integer before shipping. jsdom cannot
catch this class of bug either, for an unrelated reason (it's a pure math
bug, not a DOM/layout one) -- it was caught because the UI's own visual
result looked implausible on inspection, not because any automated check
flagged it.

### Correction: the dilution picker was never part of the agreed design -- removed (2026-07-30)

Real feedback, and correct: the "Dilutes: [group]" dropdown shipped with
cantrips was never in any agreed mockup -- it was added unilaterally while
resolving an open design question during implementation, without flagging
it as a deviation. Removed.

The proposed replacement heuristic ("dilute whichever group is most
populous, since it contributes least per copy") is usually right but not
ALWAYS: an OR query like "A>=3 OR B>=1" can make the more-populous group
the actual bottleneck rather than the safe one to cut. Rather than adopt a
heuristic with a known failure mode, `bestDilutionChoice` tries every
candidate group directly and keeps whichever one actually gives the
highest resulting success rate -- exact, not approximate, and free given
candidate groups are always few (this app caps queries at 4) and
evaluate() is cheap. Confirmed with a REAL constructed counterexample
(15-copy group needing >=3 vs. a 2-copy group needing >=1): the naive
"most populous" pick would have been measurably worse, not just
different, than what bestDilutionChoice actually selects.

Extended to marginalValuePerCopyAutoDilute and copiesNeededForTargetAutoDilute,
which re-run bestDilutionChoice at every count tried during a search (not
just once, upfront) -- the best group to dilute can shift as more copies
get added, since one group's count could be fully diluted away before
another's. The UI now shows which group got auto-selected as read-only
text in the exact-mix scope note, not as an editable picker -- transparency
without asking the user to make a decision the tool can make correctly
itself.

### Two real fixes (2026-07-30)

- **Deck size combobox bug: reported as "only has 40," confirmed as a
  browser-compatibility issue, not a markup bug.** The DOM/datalist itself
  always had all 3 options (verified directly) -- the problem is
  `type="number"` + `<datalist>` having known, real cross-browser
  inconsistency (Safari in particular often only shows the current value,
  not the full suggestion list). Fixed by switching to `type="text"` +
  `inputMode="numeric"` (keeps the numeric keyboard on mobile; datalist
  support for text inputs is far more reliable across browsers). This
  changed which CSS selectors apply -- `input[type="number"].deck-num` and
  `input[type="number"].deck-size-combo` no longer match a type=text
  element at all, so the width rule needed to drop the now-irrelevant
  attribute selector (confirmed no other rule was competing for a bare
  type=text width before simplifying it).
- Removed the cantrip exact-mix scope note ("Cantrips dilute X once your N
  filler slots run out...") -- unnecessary per direct feedback.

### Real bug: chart tooltip rendering far from the cursor (2026-07-30)

Reported directly: "the graph hover tooltip is way away of where the actual
cursor is." Confirmed the exact mechanism in a real browser before touching
anything: `event.clientX`/`clientY` are already reported in final, POST-zoom
viewport pixels (mouse at real screen position 684.5 produced clientX=684.5,
NOT 684.5/1.5). Using that value directly as a `position: fixed; left`
therefore gets zoomed a SECOND time by the page's `zoom: 1.5` when the
browser renders that CSS length -- producing an offset that grows with
distance from the origin (measured: 356.5px off at x=684.5).

This is the EXACT same class of bug already found and fixed once for
rail-dragging (`computeRailWidthFromDrag`'s own comment describes it
identically) -- but the fix wasn't generalized to every OTHER place
clientX gets used as a CSS length, which is exactly how it slipped through
for the chart tooltip. Extracted the shared correction into `zoom.ts`
(`zoomFactor()` reads the DOM, `unzoomedPosition()` is the pure, testable
arithmetic) so both call sites share one implementation instead of two
copies that could drift, and so any FUTURE clientX-as-CSS-length site has
an obvious existing utility to reach for instead of re-deriving the fix
(or missing it) again.

Verified the fix directly in a real browser, not just reasoned about:
offset dropped from ~356px/321px to ~14.5px, which itself exactly matches
the tooltip's own intentional `transform: translate(10px, 10px)` CSS (10px
* 1.5 zoom = 15px) -- correctly still zoom-scaled since that value is
static, not derived from clientX. Confirms the fix is complete, not just
improved.

### Cantrips into the deck builder: scoping discussion, corrected (2026-07-30)

Raised: should card-selection effects (cantrips) move from the Questions
tab's exploratory "what if" tool into real, tracked deck groups -- so the
main Chart/Table/Grid/advisor reflect the ACTUAL deck's card-selection
adjusted winrate, not just a side question. Reasoning: card selection
genuinely affects global winrate, and the advisor could suggest "or add N
copies of a cantrip" the same way it already suggests other groups.

Initial framing of the cost/complexity was corrected on three points, each
worth recording precisely rather than smoothing over:

1. **"Why branch?"** -- correct pushback. Treating this as a special-case
   branch in the core computation was the wrong framing. If cantrips are
   real tracked groups, the model should use them UNCONDITIONALLY, the same
   way every other group already works -- not "does this deck have
   cantrips, if so take a different path." Zero cantrips in the deck is
   just the normal case where that part of the computation contributes
   nothing, not a special path being skipped. The generalization should
   subsume the simple case automatically, not sit beside it as an if/else.

2. **Dilution is not, and was never, the interesting question.** Correct,
   and this reframes a real amount of engineering effort from this same
   session. `bestDilutionChoice` and the auto-dilute variants exist
   entirely because of the Questions tab's HYPOTHETICAL framing -- "what if
   I added N cantrips without yet deciding what to cut." That ambiguity is
   an artifact of exploring a change to a deck that doesn't exist yet. Once
   cantrips are real tracked groups, there is nothing to resolve: the user
   sets every group's count directly, "Others" reflects whatever's left,
   exactly like every other group today. The actual interesting question,
   now and always, was never "which group absorbs the cost" -- it's simply
   "how much does including N real copies of this effect change my
   winrate," i.e. the direct impact of card-selection inclusion. The
   dilution machinery remains useful ONLY for the exploratory Questions-tab
   version (deciding whether to add cantrips to a deck at all, before
   committing real slots to them) -- it should not be treated as core
   infrastructure the main-deck integration depends on or inherits.

3. **The mulligan/cantrip overlap means reconciliation is required, not
   optional.** Agreed without qualification. Both models are fundamentally
   the same idea (condition on a hypothetical reveal, project forward under
   optimal keep-the-useful-cards play) applied at different moments -- the
   opening hand specifically (mulligan.ts) versus an ongoing draw-by-turn
   process (cantrips.ts). Building the main-deck integration without
   unifying these into one coherent framework would mean the two
   "compatible in spirit" systems staying uncomposed forever, or attempting
   a plausible sequence like "keep decision, THEN cantrip-adjusted draws"
   as an afterthought that gives an approximate rather than exact answer.
   The unification is part of the core scope of this project, not a nice-
   to-have layered on top afterward.

Given all three corrections, the actual shape of this project is: (a)
generalize the core curve computation to treat card-selection groups as an
ordinary part of the model, no branching; (b) do NOT bring the dilution/
auto-select machinery along -- it has no role once cantrips are real
groups; (c) unify mulligan.ts's opening-hand model and cantrips.ts's
ongoing-draw model into one framework before wiring either into the main
computation, since building on two divergent models would need redoing
later anyway. Still a substantial project -- comparable in scope to
mulligan.ts's original build -- but smaller and better-shaped than
initially framed, once dilution is correctly recognized as belonging only
to the exploratory tool, not the core integration.

Not started. This is the next scoped piece of work whenever picked back up
-- a good starting point for a fresh session, since everything needed to
resume is written here rather than living only in conversation history.

### Unifying mulligan.ts and cantrips.ts: reveal.ts, and both closed forms proved wrong (2026-07-30)

Correction 3 of the scoping discussion above (the mulligan/cantrip overlap
makes reconciliation required, not optional) done first, before any main-deck
wiring, exactly as that entry argued.

**`src/math/reveal.ts`** is the shared primitive: a reveal is THREE separate
facts, and conflating any two is where the two previous implementations
diverged -- (1) which cards left the unseen pool (`comp`/`total`: hand,
bottomed, exiled and milled are ONE fact for a query about what you draw),
(2) which of them count toward the query (`secured`, a subset -- a card kept
on top is yours only once a draw is spent collecting it), and (3) how many
further cards get drawn, which isn't part of the reveal at all, hence
`projectForward` returning a whole curve. mulligan.ts's `shiftBox`,
`enumerateHands`, `keepValue`, `keepCurve` and `remainingSizes` are now thin
callers of it. Verified BYTE-IDENTICAL output (not merely a passing suite)
across 4 configurations including a non-monotone one, by snapshotting before
and after the refactor and diffing.

**Effect taxonomy, settled.** The axes are mechanical, so the table has four
columns instead of a row per card name:

| effect | examined | keepMax | kept costs a draw | non-kept leaves pool |
|---|---|---|---|---|
| draw X | X | X (all) | no (goes to hand) | -- |
| scry/preordain X | X | inf | YES (sits on top) | yes |
| impulse/surveil X | X | 1 | no (hand/exile) | yes |
| ponder/portent X | X | inf | yes | NO + shuffle option |

Two consequences recorded during that discussion. First, a flat additive
`bonus` is only exact for `>=1` queries: scry's kept cards cost draws, so for
`>=2` with few draws left the additive model claims cards you never got to
collect. Advance must be DERIVED from {examined, keepMax, fate}, never
supplied as a number. Second, impulse's "which of the two pieces do I take" is
a max over commit choices against the shifted DNF -- the same shape as
mulligan's keep decision -- not a heuristic to encode; "take the rarer one"
is an OUTPUT.

Ponder's stall was briefly deferred and then un-deferred: in the no-shuffle
branch the two halves CANCEL EXACTLY (reordering the top 3 doesn't change
which cards you acquire, since you'd have drawn them anyway), so its whole
modelable value is the shuffle option plus best-of-window when the goal turn
cuts through the window. No draw-schedule coupling, no MDP.

**Both candidate closed forms are wrong -- the real finding.** Built
`src/math/bruteSelection.ts` (TEST-ONLY, like exact.ts/brute.ts): enumerate
every distinct ordering of a small labelled deck, play each out with the real
mechanics (top of library, bottoming, exiling, hand), count successes. No
hypergeometric anywhere in it, so a disagreement indicts the closed form
rather than being a shared bug. Validated first against `evaluate()` with the
effect disabled: agrees to 5e-16.

Measured error in percentage points (N=12, A=3, 2 copies):

| case | flat (today's cantrips.ts) | conditioned |
|---|---|---|
| draw2, A>=1, n=3 | -3.30 | -5.64 |
| draw2, A>=2, n=5 | -2.57 | -6.64 |
| scry2, A>=1, n=3 | +1.05 | -1.30 |
| scry2, A>=2, n=3 | **+8.15** | +4.05 |
| impulse3, A>=2, n=3 | +4.55 | +1.19 |

Neither is exact anywhere, and the SIGN FLIPS by effect type and threshold.
The per-k breakdown (n=3, E=2) shows why:

| copies drawn k | brute | flat | conditioned |
|---|---|---|---|
| 0 | 0.70833 | 0.61818 | 0.61818 |
| 1 | 0.80556 | 0.84091 | 0.78788 |
| 2 | 0.91667 | 0.95455 | 0.91667 |

k=0 and k=2 both match a THIRD form (pool = deck minus every effect copy)
exactly; k=1 matches nothing. Conditioning on "k copies among the first n"
mixes two different pools: the n-k other scheduled cards come from the
non-effect pool, while the k*examined window cards come from the remainder,
which still holds the other copies. One hypergeometric cannot express that, so
no single-index closed form can be right -- and at k=0 and k=2 the two pools
coincide, which is exactly why the original single-effect validation looked
clean. Both forms were deleted rather than left as options; the shipped
cantrips.ts flat form is therefore known-wrong by single-digit points, in a
direction depending on whether "look 3" is read as draw-like (understates) or
scry-like (overstates).

**The exact model: a sequential slot DP, and it needs no group dimensions.**
The structural simplification that makes it cheap: the query's own group
composition is conditionally hypergeometric GIVEN the slot structure, because
the mechanics only care about WHERE the effect copies fall (a copy in a
scheduled slot triggers; a copy inside another copy's window does not), which
is independent of which non-effect cards fill the remaining positions. So the
DP tracks (cards consumed, copies consumed, scheduled slots used, window
credits owed) and NOTHING about groups; composition comes from one ordinary
`evaluate()` on the pool with every copy removed. "No cascading" stops being
an assumption and becomes the `credits > 0` branch -- one line to change if the
fuller model is ever wanted.

`exactDrawCurve` matches bruteSelection.ts to ~1e-15 across 32 cases (4 deck
configs x 2 thresholds x 4 draw counts) where the flat form is off by up to 7
points. Zero copies is an EXACT passthrough of `evaluate()` (=== , not
toBeCloseTo), so the generalization subsumes the plain case rather than
sitting beside it -- correction 1 of the scoping entry, satisfied structurally.

The slot DP is query-INDEPENDENT, so it's split out (`slotDistribution`) and
cached: measured 117ms cold / 11.5ms warm at 99 cards with 12 copies, meaning
a grid sweep or a target change pays it once, not per row. At ~160ms
uncached this is the same order as the mulligan computation that already
needed the Worker (CLAUDE.md #13), so main-thread use should go through the
same worker infrastructure rather than being assumed cheap.

One test expectation was written wrong and the DP was right (`examined=0`
should reproduce the FULL deck's curve -- a dead card occupying a slot, 6/40 on
the first draw -- not the deck-minus-copies pool at 6/36). Recorded because
that's the correct direction for a check like this to fail.

Staging from here, each step gated on its own brute-force case before the next:
scry (kept-costs-a-draw), then impulse (keepMax with the commit-choice max),
then ponder (shuffle option), and only then main-deck integration.
`assertDrawShaped` makes every not-yet-implemented shape throw rather than
silently borrowing the draw path.

### All four selection shapes, exact and brute-force verified (2026-07-30)

Staging carried through: scry, then impulse, then ponder, each gated on its own
brute-force case before the next. All four now agree with a full play-out of
every distinct deck ordering to 2.2e-16, for a single-group threshold query.

Two implementations exist on purpose, cross-checked against each other:
`exactDrawCurve` (slot DP, no group dimensions) and
`exactSelectionCurveSingleGroup` (atomic-window engine carrying group state),
plus `exactScryCurveSingleGroup` (card-by-card scry) as a third derivation of
the scry numbers. Agreement between derivations that don't share a formulation
is evidence; agreement between a function and itself isn't.

**Scry needed group state back, and three things kept it small.** Unlike the
draw case the PLAY depends on card identity (keep what you need, bottom the
rest), so the query can't be factored out. But success absorbs (live states
always hold fewer than `threshold`), no needed card is ever bottomed (so
acquired and consumed coincide for that group), and running out of scheduled
draws absorbs too -- the last of those IS "kept cards cost a draw", the fact a
flat additive bonus cannot express.

**Windows resolve atomically** (enumerate the whole window's composition, then
decide) rather than card-by-card. Required for ponder, whose shuffle decision is
made with the whole window visible; as a bonus it removes the credits-owed
dimension for the other shapes.

**Ponder: the reorder branch's two halves cancel exactly, as predicted.**
Consuming the window as draws with the useful cards ordered first has zero net
advance, so all of ponder's value is the OPTION to shuffle instead, plus
best-of-window when the goal turn cuts through the window. Pinned by a test
that the shuffle option is worth >1 point, since a bracket test alone would
pass even if `canShuffle` were wired up but inert.

**Three bugs, and only one of them was in the model.**

1. *Impulse (model).* Exiled copies weren't leaving the pool: the remaining
   count was derived from ACQUIRED rather than CONSUMED, and an impulse capped
   at one keep exiles the second useful card it sees. Overstated impulse by up
   to 2 points. `aCons` is now its own dimension.
2. *Ponder (brute force).* The simulator put the rejected cards back on top
   ABOVE the kept ones, i.e. drew the duds first -- and it had no shuffle
   option at all. Caught not by the diff but by an impossible ORDERING: brute's
   ponder (0.586) came out below not pondering at all (0.618), which no
   optional effect can do. Fixed, and the ordering invariant
   (plain <= ponder-no-shuffle <= ponder <= scry <= draw) is now a test, since
   it catches a wrong window resolution even when every individual number looks
   plausible.
3. *Bottoming (brute force).* Rejected cards were pushed to the END of the
   array, which is genuinely reachable when an 11-card deck sees 7 draws plus
   windows -- and only that configuration mismatched. Bottomed now means
   unreachable, matching the model's own assumption.

**The no-cascading scope is now measured, not asserted.** The brute force takes
a `cascade` flag: with it off it checks the model exactly, and with it on it
prices the assumption. A copy that ponder puts BACK on top really does get
drawn and cast later, worth up to +15.45 points at 6 copies of a look-3 effect
(+1.4 to +1.9 at 4 copies of look-2). For draw/scry/impulse the same flag moves
nothing at all (0.00pt) because a window copy there is bottomed, exiled, or
already in hand -- so this instrument prices ONE cascade path. The other path,
casting a copy drawn into hand, isn't modeled by the brute force either and
therefore stays a stated caveat rather than a measured zero. Recorded that way
deliberately: "cascading costs 0.00 for three of four shapes" would be a true
sentence and a misleading one.

**Still open, and the reason this stops here: multi-group queries.** Everything
above is a single-group threshold query. Generalizing needs the keep DECISION to
become a max over which cards to commit, evaluated against the shifted DNF --
the same machinery reveal.ts's doc comment already flags as belonging to the
caller. For an AND of `>=` thresholds, greedy "keep anything still needed" is
optimal and the extension is mechanical. For an OR, it genuinely isn't: keeping
a card commits you toward one clause at the cost of draws that might have served
another, so the choice is a real optimization and the state has to carry
per-group acquired counts. That is the next piece of work, and the last one
before main-deck integration.

### Multi-group selection effects: exact, but perf is now the binding constraint (2026-07-30)

`exactSelectionCurveAnd` extends all four shapes to an AND of thresholds over
several tracked groups. The genuinely new thing is that the keep decision
becomes a real CHOICE -- a window holding a land and a combo piece, with an
effect that can take only one, is an optimization -- so it maximizes over every
legal commit vector. "Take the one you lack" and "take the rarer one" are
outputs of that max, never encoded, exactly as the taxonomy discussion argued.

**Verification had to change shape, and that's informative.** For draw and
ponder there is no choice (you take the whole window, or the whole window gets
drawn), so any fixed policy is optimal and the brute force must match EXACTLY --
it does. For scry and impulse an exact match against a fixed greedy policy would
mean the model is failing to optimize, so those are SANDWICHED between the greedy
policy (a lower bound) and a new clairvoyant brute force that chooses keeps with
the rest of the deck visible (an upper bound, since foresight can only help).
Measured bands are tight, e.g. greedy 0.7689 <= DP 0.7741 <= clairvoyant 0.7795.
The clairvoyant bound branches over every keep subset at every window for every
ordering, so it's checked at the smaller window size only -- affordable where it
fits rather than quietly dropped.

**A memo-collision bug worth recording precisely.** The big speedup is
canonicalizing satisfied groups into the filler pool (a group whose threshold is
met is indistinguishable from filler for every remaining decision and outcome,
so folding is exact and collapses every state differing only in a satisfied
group's leftovers). But folding pushes the filler count ABOVE the deck's
original filler total, and the packed mixed-radix state key had that field sized
for the UNFOLDED maximum -- so distinct states collided and returned each other's
memoized values, wrong by 1.5 points. Caught by the brute force on the next run;
invisible without it, since the numbers stayed plausible and monotone. Now a
regression test at the exact configuration that broke.

**Perf, measured.** Single group is comfortable: 37ms at 99 cards with 10
copies over 25 draw counts. Two groups is not: 164ms at 40 cards and 1.6s at 60
cards, after a 4.6x improvement from numeric state keys (7.5s originally) plus
the folding above. That's worker-territory for a single curve -- acceptable the
same way the multi-second mulligan cases already are, with a loading state -- but
a GridTab sweep multiplies it by every row, and unlike `slotDistribution` this
DP is NOT query-independent, so it can't be cached across rows the same way.

Open, in the order they block things:
1. **Where multi-group selection may be used.** A single advisor/chart point is
   fine today; a grid sweep is not, without either more perf work or a
   deliberate restriction (e.g. selection-adjusted values on the chart only,
   raw values in the grid with a visible note, which is the pattern GridTab
   already uses when its search space is too large).
2. **OR queries.** Needs the same max but over a state that can pursue different
   clauses -- keeping a card commits draws toward one clause at the expense of
   another. Not approximated in the meantime; `exactSelectionCurveAnd` takes
   thresholds, not a Dnf, so there's no path to call it with an OR by accident.
3. **Non-monotone queries** ("exactly 1"). Breaks the success-absorbs property
   the state space relies on, since drawing MORE can un-satisfy the query, so
   the DP would have to run to exhaustion and test at the end.
4. Main-deck integration, after the above.

### Multi-group perf: 10.5x, and where it still doesn't reach (2026-07-30)

Three changes, each verified against the brute-force suite immediately after
(lesson #19 -- a state-space optimization changes which states exist):

1. **Numeric mixed-radix state keys** instead of string keys: 7.5s -> 3.1s.
2. **Canonicalizing satisfied groups into the filler pool** (exact: a group whose
   threshold is met is indistinguishable from filler for every remaining
   decision): -> 1.6s. This is the change that introduced the memo-collision bug,
   because it widened the filler field's real range.
3. **Dense Float64Array memo** when the packed key space fits under 8M entries,
   sparse Map otherwise (-> 934ms), then **mutate-and-restore of the `rem`/`acq`
   vectors** instead of copying them per transition (-> 708ms). Every recursive
   path now leaves both arrays exactly as it found them; the ponder shuffle
   branch has to be evaluated BEFORE the window is removed from the pool, since
   it's the one branch that needs the un-mutated pool.

Net: 60-card two-group scry, 15 draw counts: 7468ms -> 708ms. At 20 draw counts
it's 1182ms. Single group is 37ms at 99 cards.

So: fine in a worker for one curve, still too slow to sweep a grid (rows
multiply it, and this DP is query-dependent so it can't be cached across rows
like `slotDistribution`). Both agreed: keep the grid restriction AND keep
optimizing.

Remaining perf option, NOT done: error-bounded pruning of negligible-probability
states, reporting the dropped mass as an explicit interval rather than degrading
to a heuristic. It needs the DP reformulated FORWARD (mass propagation) instead
of backward (value function), because a backward value function has no
probability mass to threshold on. That's a real restructuring, so it's recorded
rather than half-started.

### Combining combos: the premise was already half-true (2026-07-30)

Proposed: a top-level AND/OR/XOR toggle plus per-combo enable checkboxes.
Correction: combos are ALREADY OR'd (`builder.ts`: a query is a union of combos,
each combo a flat AND), so "at least one combo online" is what ships today.

- **AND toggle**: nearly free. ANDing flat ANDs is merging them into one clause,
  a builder-level rewrite with no new math and no perf cost, and it stays
  monotone. Wrinkle to handle explicitly: a merge can contradict (`A>=2` with
  `A<=1`) and must say "impossible" rather than quietly showing 0%.
- **Per-combo enable checkbox**: cheap, non-destructive, and the thing that
  actually answers "which combo is carrying my number".
- **XOR**: two independent problems. Over 3+ clauses XOR is PARITY, which nobody
  wants -- the intent is "exactly one", so it should be named that. And
  "exactly one" is non-monotone, which is load-bearing here: `frontier.ts` is
  monotone-only so suggestions go dark, and it breaks the success-absorbs
  property the entire selection DP relies on. The base percentage is computable
  today (complementing an AND yields upper bounds, which `evaluate()` handles) at
  the cost of clause blowup, but it would be a mode where the advisor and
  selection effects silently stop working.

Recommended instead of XOR: per-combo CONTRIBUTION percentages (each combo's own
probability alongside the union). Monotone, cheap, reuses existing math, and it's
what isolating combos is actually for. Exactly-one deferred until something
concrete needs it.

### Upper bounds / bricks: implemented, and they invert the effect ranking (2026-07-30)

Requested and correct: a deck has cards you actively don't want (bricks,
garnets), which is a `hi` bound -- usually `=0`, sometimes "at most k". The key
observation driving it: LOOKING saves you from a brick, DRAWING cannot, because
scheduled draws are forced. That asymmetry is unapproximable, so `TrackedGroup`
now takes an optional `hi` (defaults to `count` = unbounded).

**Measured consequence, N=12, A=3, 2 bricks, 2 copies of look-2, P(A>=1 and no
brick):**

| draws | no effect | draw 2 | scry 2 | impulse |
|---|---|---|---|---|
| 3 | 0.386 | 0.352 | 0.463 | 0.459 |
| 5 | 0.292 | **0.163** | 0.339 | 0.313 |

Drawing is WORSE THAN HAVING NO EFFECT (0.163 vs 0.292) because its window is
forced into hand. Looking roughly doubles it. This exactly inverts the monotone
ordering (where draw >= scry, cards being free rather than costing draws), so
the ordering test is now regime-specific rather than global.

**What upper bounds change structurally** (not just an extra check):
- success stops absorbing -- satisfied on turn 3, busted on turn 4 -- so bounded
  branches run to the draw horizon;
- a bounded group can never be folded into the filler pool, since a later copy
  can still bust it (folding being the main speedup);
- keeping a useful card stops being automatically right, and DECLINING becomes a
  real move. `hi=0` buys some cost back: busting is absorbing FAILURE, which
  prunes hard and needs no state dimension.

**The exactness CLASS depends on the query regime, not just the effect.**
Ponder-no-shuffle has no meaningful choice under monotone queries (every card is
welcome, so window order is irrelevant) and matched the brute force exactly.
With a brick, ordering it below the draw horizon is a real decision, so greedy
stops being optimal and it moves into the sandwiched group. Only `draw` stays
exactly checkable, its window being wholly forced.

**One bug, caught by the sandwich rather than by a diff.** In ponder's truncated
window (fewer draws left than window size) I let the commit vector take FEWER
cards than the remaining draws. But the window sits on top of the library: you
choose WHICH cards you draw, never HOW MANY. That let an already-satisfied state
decline a brick it was really forced to draw, putting the DP 0.001 ABOVE the
clairvoyant upper bound -- impossible by construction, which is what flagged it.
Now the untracked window cards have to absorb the remaining forced draws, and the
split is rejected when there aren't enough of them.

**Perf in this regime** (60-card, two groups, 15 draw counts): `hi=0` bricks are
CHEAPER than the monotone case at 627ms (absorbing failure prunes), while "at
most 2" is the expensive shape at 1762ms -- it can bust but neither absorbs early
nor folds. Worth knowing which bound a user typed before assuming the cost.

**Downstream consequence to handle before this is wired into the UI: bounded
curves DECREASE in draws.** Pinned by a test. Anything phrased as "draws needed
to reach 80%" or that assumes a nondecreasing curve is invalid for a bounded
query, and `frontier.ts`/the advisor are monotone-only, so they must stay dark
for these queries rather than silently returning nonsense.

### OR of clauses: exact, plus the fast path that makes it usable (2026-07-30)

`exactSelectionCurveDnf` is now the general entry point (OR of clauses, each an
AND of per-group bounds); `exactSelectionCurveAnd` delegates to it, so the 80
existing tests validate the generalization rather than a parallel implementation.

OR is not a missing concept -- the keep-choice max already covers "which clause
am I pursuing", since it maximizes over commit vectors and the value function
tests every clause. Earlier framing of it as a modeling gap was wrong. What it
costs is state:
- a group in two clauses with different `lo` must be tracked to the higher one;
- folding needs EVERY still-alive clause to be both satisfied and unbounded on
  that group, which is much rarer;
- busting can no longer prune, since exceeding one clause's bound is fine if
  another tolerates it. The single-clause path lost its bust-exit for generality.

Verified against a new OR-aware brute force: draw exact, choice shapes inside the
greedy/clairvoyant sandwich. The greedy gap is visibly nonzero (0.330 vs 0.358 at
n=3), which is the point -- committing a card toward one clause spends draws
another clause wanted, so the max earns its keep. Ponder-no-shuffle actually
ATTAINS the clairvoyant bound here, i.e. foresight buys nothing beyond ordering.

**Perf: the heavy engine cannot do OR at realistic sizes.** 6.0s at N=40, 24.6s
at N=60 (three groups, two clauses), 13.1s with a brick. Three groups plus two
clauses is simply past what this state space allows.

**But draw-shaped effects have a 390x fast path, and it covers everything.**
A draw effect forces its whole window into hand, so the resulting hand
distribution doesn't depend on the query at all -- which means the slot DP
(`exactDrawCurve`: no group dimensions, query-independent, cached) handles ANY
query `evaluate()` handles, including OR and upper bounds. Verified to 1e-15
against the heavy engine on both an OR query and a brick query. Timings: 63ms for
N=60 OR with three groups, 78ms for OR + brick, versus 24.6s heavy. So routing
matters enormously: a draw-shaped effect must never reach the heavy engine.

Resulting map of what's affordable, which is the thing to design the UI against:

| query shape | draw-shaped effects | scry / impulse / ponder |
|---|---|---|
| single AND, monotone | slot DP, ~60ms | exact, 0.7s (worker) |
| single AND + brick | slot DP, ~78ms | exact, 0.6-1.8s (worker) |
| OR of clauses | slot DP, ~63ms | 6-25s: NOT viable |

So the open question is narrow: what to do for CHOICE-shaped effects on OR
queries. Options, in preference order:
1. Compute the max over single clauses as a documented LOWER bound (committing to
   one clause is a feasible policy, so it's rigorous) and show it as such.
2. Monte Carlo with a fixed policy plus visible confidence interval -- the one
   place MC earns its keep, since the DP is 25s and MC's weakness (resolving
   ~1pt differences) is less damaging than no answer at all.
3. More perf work on the heavy engine, payoff uncertain.
Not an option: silently routing an OR query through a single-clause
approximation, which is what the deleted flat form did in spirit.

Also worth noting from the mixed brick/payoff analysis (3 enablers, 1 garnet,
40 cards): drawing is clearly GOOD there (+6.1pt at 6 draws) and only decays to
+0.9pt by 12 draws, crossing to harmful around 13. Bricks make draws worse only
once the payoff saturates -- so the advisor's useful output is the CROSSOVER draw
count, not "avoid draw effects" and not going dark.

### OR of clauses, optional casting, and a real perf wall (2026-07-30)

**OR done.** `exactSelectionCurveDnf` takes a full DNF (OR of clauses, each an
AND of per-group bounds); `exactSelectionCurveAnd` is now the single-clause case
delegating to it. This is the shape the app already produces -- two combos ARE an
OR -- so it was the gate on anything reaching the UI, not an extra mode.

OR costs state rather than concepts, for three nameable reasons: a group in two
clauses must be tracked to the higher `lo`; folding into the filler pool now
needs EVERY live clause to be done with the group; and busting stops pruning,
since exceeding one clause's bound is survivable when another tolerates it.
A dead clause stays dead (counts only rise), so aliveness is recomputed rather
than carried in the state.

One correctness subtlety specific to OR: a draw-shaped effect must take a SINGLE
FORCED branch, not a max over subsets. Under one AND clause the distinction is
invisible (taking more never hurts when it doesn't bust), but across clauses a
partial take can satisfy a clause the full window busts -- and drawing cannot
decline, so offering the choice would overstate it.

**`optionalResolve`, from a real-play objection.** The model forced every drawn
copy to resolve, which is what made drawing look strictly worse than doing
nothing under a brick query. But casting is a choice: a deck that must run a
brick (Brilliant Fusion at 3 copies, needing its Garnet) still casts the copy,
while a generic draw spell just wouldn't be cast. With declining allowed --
decided BEFORE the window is revealed, since that's when the choice really
happens -- at n=5 on the brick query:

| | must resolve | optional | no effect |
|---|---|---|---|
| draw 2 | 0.163 | 0.295 | 0.292 |
| scry 2 | 0.339 | 0.339 | 0.292 |

Drawing is no longer below the baseline, and scry is UNCHANGED because refusal
was already available to it. For monotone queries the flag is worth exactly 0.0
(resolving is never a mistake when every card is welcome), which is pinned with
`toBe` rather than a tolerance. Default stays false, matching what the brute
force plays, so the exactness checks keep their meaning.

Correction to record: the earlier claim that "bounded curves decrease, so the
advisor must go dark for bounded queries" was too coarse. A mixed query rises
and then TURNS OVER, and the advisor should change its MESSAGE at that point
("draws past turn N cost more brick risk than they gain") rather than go silent.
The right test is empirical -- compute the curve and look for the turnover --
not structural. `frontier.ts` keeps its up-set gate, which is a different
property.

**Perf wall, measured.** Two clauses sharing groups:

| case | draw | scry |
|---|---|---|
| 40 cards, 2 clauses | 47ms | 195ms |
| 60 cards, 2 clauses | 131ms | 1626ms |
| 60 cards, 2 clauses + brick | 162ms | **16511ms** |

Draw shapes stay cheap everywhere (single forced branch, no window
maximization). The look shapes are what explode, and OR + brick + scry at 16.5s
is unusable even in a worker. Both folding blockers stack there: the brick can
never fold, and each clause still wants the other group.

So the honest boundary today: single clause is fine, OR with draw effects is
fine, OR with look effects is borderline at 60 cards, and OR + bounds + look
effects is out of reach. Options, in increasing order of work: restrict which
combinations the UI offers a selection-adjusted number for; forward-formulate
the DP so error-bounded pruning becomes possible (recorded earlier, still
unstarted); or add a Monte Carlo fallback for the heavy corner.

**Monte Carlo, analyzed properly.** Not a perf win at the precision this app
displays: ~1e6 samples for +-0.05pt is seconds in JS, the same order as the DP's
worst case. And MC needs a POLICY, while optimal play is exactly what the DP
computes, so sampling a greedy policy yields a lower bound rather than the
answer. Its two real uses: validation at REALISTIC deck sizes (the brute force
caps out around 12 cards, so nothing currently checks a 99-card deck end to
end -- a genuine hole), and honest fallback coverage for the heavy corner,
reported as a policy lower bound with a confidence interval, never as an exact
value.

**An About page is now justified** and its content already exists in this file:
which shapes are exact vs bracketed, the no-cascading assumption priced at up to
+15pt for ponder, why looking beats drawing under a brick, and that casting is
modeled as optional. This matches the project's convention of stating modeling
limits in the UI rather than only in the repo.

### The modified-query method: shipped for impulse, still short for scry (2026-07-30)

Proposed in session: instead of walking the process, note that `hold = seen -
ditched`, so whatever you had to let go simply SHIFTS the query. Ditch an A and
`A>=2` becomes `A>=3` over the seen population; bottom a brick and `C<1` becomes
`C<2`. Lower bounds and caps move by the same rule, so bricks need no special
case. Enumerate window contents, weight by hypergeometric, average.

Verified in stages before trusting any of it:
- the accounting identity itself: `hold = scheduled + windows-holding-one`,
  checked against every one of 7920 arrangements, zero disagreements;
- the slot-structure factor `P(triggers, copies-inside-windows)`: matches
  enumeration to 1e-17;
- the position split of needed cards between scheduled and window slots:
  matches enumeration term by term;
- one copy: matches the exact DP to 1e-15;
- ANY copy count with need=1: exact to 1e-15, confirming that impulse and draw
  differ ONLY when more than one still-missing piece appears in a window.

**Shipped as `modifiedQuery.ts`, for capped-keep effects only.** It is a
RELAXATION, hence a rigorous upper bound: the keep budget is pooled across
windows (it can keep two from one window when another was barren) and keeps are
chosen with every window visible at once. Every measured deviation is positive,
as that predicts. Accuracy depends on the draw horizon as much as the deck:
+0.02pt at 15 draws on a 60-card two-clause brick query, +0.20pt on the same
query at 10 draws, +0.47pt on a small dense deck, +0.76pt at 12 cards. Since it
is worst exactly where the exact DP is cheapest, the agreed split is: exact DP
when affordable, this when not.

**Tolerance, set explicitly:** one copy of a cantrip is worth ~1.5-4pt, so
0.1pt is the bar (~5% of a copy-step), 0.05pt ideal, and 0.5pt is NOT
acceptable -- that is a quarter of the quantity being measured and is exactly
the size that flipped a "4 copies" recommendation to 3 in the legacy comparison.
A known-direction bound at 0.02pt beats an unsigned +-0.5pt estimate.

**Scry does not work yet, and three variants were measured on the wall query**
(60 cards, `(A>=2 & C<1) | (B>=2 & C<1)`, 8 copies of look-3, 15 draws; exact
DP = 0.332260 in ~24s):

| variant | value | vs exact | time |
|---|---|---|---|
| pooled-budget max over keeps | 0.364908 | +3.27pt | 5.4s |
| fixed rule, bottomed cards REMOVED from pool | 0.357416 | +2.52pt | 371ms (74x) |
| fixed rule, brick CAP BUMPED instead | 0.396328 | +6.41pt | 596ms |

Two findings there. First, dropping the max was right: scry forces no discard,
so there is nothing to choose -- keep every missing piece, bottom the rest --
and that was both 16x faster and 0.75pt more accurate. Second, cap-bumping is
strictly WORSE than removal, for a precise reason: a raised cap forgives bricks
wherever they were seen, including ones drawn into hand from scheduled slots,
while only bricks inside a window can actually be bottomed. Removal leaves the
cap at 0, so a brick reaching hand still fails, and the benefit appears where it
really is -- a less brick-dense remaining pool.

The residual +2.52pt on the removal variant is a TIMING leak, not a keep-rule
leak: every window's cards are purged from the pool up front, so a turn-8 scry's
cleanup is retroactively credited to the turn-3 draws. The fix is to condition
on trigger POSITIONS and credit each window's bottoming only to the draws that
follow it (~1.4k position splits at t<=4, n=15, so it would spend much of the
74x). Not attempted yet.

### Scry timing leak: subtraction tried, overshoots; leak localized to trigger count (2026-07-30)

Tested the proposed correction -- multiply by P(no brick drawn before the first
trigger), those draws being ones no scry could have protected. Measured on the
wall query (exact DP = 0.332260):

| variant | value | vs exact |
|---|---|---|
| removal, no fix | 0.357416 | +2.52pt |
| removal + subtraction | 0.266175 | **-6.61pt** |
| removal, no fix, ONE copy | 0.294418 | +0.22pt |

The subtraction DOUBLE-PENALIZES. The removal model already fails outright when
a brick reaches a scheduled slot (the cap stays 0 and nothing forgives it), so
multiplying by P(no early brick) strips mass that was never counted as success
in the first place. The intent was to remove wrongly-KEPT successes; the
multiplicative form removes all early-brick mass instead.

The one-copy row localizes the actual leak: +0.22pt with a single trigger versus
+2.52pt with eight. So it scales with the NUMBER OF TRIGGERS, which rules out
the keep rule and confirms cross-window aggregation -- every window's cards are
purged from the pool at once, so windows retroactively clean up each other's
earlier draws. One window has nothing to cross-contaminate, and the error nearly
disappears.

Next attempt, if scry is picked up again: the same correction applied
PER-TRIGGER rather than as a global factor -- condition on trigger positions and
purge each window forward only. That removes exactly the wrongly-kept mass. Cost
estimate stands at ~1.4k position splits for t<=4, n=15, which would spend much
of the current 74x speedup.

### Cantrips card swapped onto the exact engine (2026-07-30)

The Questions-tab cantrip card ran the disproven flat form until now. Swapped to
`exactDrawCurveMulti`, keeping the public API of `cantripSuccessRate` unchanged
so `CantripsCard.tsx` needed no edit, and keeping the dilution wrapper exactly
where it belongs (dilution decides GROUP COUNTS; the engine takes counts as
given -- correction 2 of the original scoping, still honoured).

Verified independently rather than trusted: `cantripSuccessRate` now agrees with
`exactSelectionCurveDnf` to 1e-10 across four configurations that previously
diverged by 0.74-1.74pt, and marginal value per copy reports 1.735pt where the
flat form said 1.498pt -- the ~10% systematic understatement is gone.

Multi-type support needed a multi-type slot DP (`slotDistributionMulti` /
`exactDrawCurveMulti`), since a mixed cantrip list has different look sizes per
type and each drawn copy grants credits according to its own type. The brute
force gained a multi-effect play-out to check it.

Cost is comfortable because the slot DP is invariant across dilution candidates
-- deck size and copy count don't change when dilution moves counts between
groups -- so each candidate costs one extra `evaluate()`, not a fresh DP.
Measured: marginal value 3-12ms, `bestDilutionChoice` 0-7ms, and the worst case
is the 99-card "copies needed for target" search at 222ms for 13 counts. Fine
for a live column.

Note for whoever reads the card's numbers: `bonus` means cards EXAMINED, which
is draw-shaped in the settled taxonomy. Someone entering Preordain is really
scrying, and draw dominates scry on monotone queries, so the card is an upper
bound for those cards. Splitting `bonus` into an effect-shape selector is a UI
change, still not scoped.

### Cantrips-in-the-builder: backlog after the 2026-07-30 session

Focus narrowed to cantrip work only. Everything below is deliberately parked,
with the state needed to resume.

**BACKLOGGED — grid removal.** Reconsidering GridTab's existence entirely: it
invites the manual trial-and-error the tool is supposed to replace, its maxima
would need multidimensional visualization to be readable, and the advisor's
suggestions already answer its question better. Removing it would also delete a
whole performance class -- the query-DEPENDENT selection DP that cannot cache
across rows -- so it simplifies the selection integration more than it looks.

**BACKLOGGED — mulligan gap.** `optimalMulligan*` grants no window credits, so a
cantrip in the opening hand is invisible to it. reveal.ts already unified the
primitive this would build on, making it the cleaner of the two gaps. Do the
verification audit on the way in: its tests use `toBeCloseTo` against a
hand-rolled brute force, and per CLAUDE.md #20 an optimizer cannot be validated
by equality against a fixed policy -- confirm the brute force enumerates optimal
keeps rather than a greedy one, or the tests prove less than they appear to.

**BACKLOGGED — advisor gap.** Bigger than wiring: `frontier.ts` calls `boxCurve`
directly and has no route to the selection engines, so its feasibility test needs
rewriting rather than plumbing. It is also monotone-only, so a deck with a brick
cannot use it at all today -- meaning "advisor + bricks + selection" is the same
hard corner in different clothing. Needs a decision on what the advisor does for
non-monotone decks before it can be scoped.

**BACKLOGGED — preset UX/IA.** Presets named after real cards (Draw 1, Preordain,
Ponder, Impulse) rather than raw mechanical axes. Raised as UX-first, to be
reviewed before information architecture is defined. Note the rail row grows from
one field (count) to four (count, shape, look size, keep count), which is the
main layout consequence.

**STILL OPEN, NOT FIXED — scry with bricks and OR.** Correcting an
optimistic summary: this was NOT solved by the subtraction/multiplication
attempt. Measured, wall query:

| variant | vs exact | time |
|---|---|---|
| removal, no correction | +2.52pt | 371ms |
| removal + multiplicative subtraction | **-6.61pt** | 297ms |
| exact DP | -- | 11-26s |

The subtraction double-penalizes: the removal model already fails outright when a
brick reaches hand, so scaling by P(no early brick) removes mass that was never
counted. The one-copy diagnostic (+0.22pt vs +2.52pt at eight copies) localizes
the real leak to cross-window aggregation, and the fix it implies -- per-trigger
positional conditioning, purging each window forward only -- has not been
attempted. Until then the exact DP is the only correct path for that corner.

**NEXT, AND THE ONLY ACTIVE ITEM — composite effect shapes.** Presets exposed a
real gap: every interesting cantrip is a COMPOSITE, and the engine models one
shape per effect.

| card | actually is | expressible today |
|---|---|---|
| Divination | draw X | yes |
| Impulse | look 4, exile-keep 1 | yes |
| Preordain | scry 1 + draw 1 | NO |
| Ponder | look 3 reorder-or-shuffle + draw 1 | NO |
| Serum Visions | draw 1 + scry 2 | NO |

Not cosmetic: pure scry's kept card costs a FUTURE draw, while Preordain's own
draw collects it immediately at no cost. Same "scry 1", materially different
value. So presets need a scry(S)+draw(D) composite in the engine before any UI
can name real cards honestly.

### Why the fast path cannot cover scry: a structural obstruction, not a missing term (2026-07-30)

Chased the scry error to ground. Two findings, the second more important.

**1. A real bug, found by a regime test.** The method fed `slotDistribution` --
which is DRAW-shaped, computing `seen = n + triggers * examined` on the
assumption that every examined card is a free extra -- into a SCRY model, where a
kept card is collected by a scheduled draw. Keeps therefore consume draws that
would otherwise have gone deeper and found more copies, so the draw-shaped
trigger distribution over-counts triggers, and the over-count grows with the
number kept.

What proved it: a query where nothing is ever kept (`no bricks in hand`, no group
with `lo > 0`) is EXACT at every copy count, to floating point. Add any group
with `lo > 0` and the error appears and scales with copies. Two earlier
hypotheses died here -- up-front pool purging (the partition argument is sound)
and draw-cost clamping (would still bite in the brick-only case, which is exact).

Error map before the fix (method minus exact, points):

| query | 1 copy | 4 copies | 8 copies |
|---|---|---|---|
| 1 clause, no brick | 0.18 | 0.56 | 0.76 |
| 1 clause + brick | 0.19 | 0.82 | 1.74 |
| OR, no brick | 0.11 | 0.30 | 0.32 |
| OR + brick | 0.22 | 1.05 | 2.52 |

Note it scales with COPY COUNT, not with OR and not with bricks; those only
amplify (bricks roughly double it, and mid-range probabilities compress error
less than values near 1).

**2. Fixing it exposes the obstruction.** Computing the trigger weight inside the
window enumeration, where the keep count is known (`F = n - keeps` fresh draws,
triggers found among those), makes brick-only exact with mass exactly 1 and flips
the sign of the error -- but the weights then sum to only 0.92-0.99, with the
missing mass tracking the keep count.

That is not a bias to tune. `F = n - keeps` makes the PREFIX LENGTH depend on the
window contents, while the window contents are drawn conditional on that prefix,
so configurations with different prefix lengths are not a partition of one sample
space and cannot sum to 1.

The general statement: this whole family of fast methods rests on SLOT STRUCTURE
BEING INDEPENDENT OF CARD COMPOSITION. That holds when windows are FREE -- draw
and impulse, where the trigger count cannot depend on what you kept -- which is
exactly why `exactDrawCurve` and `modifiedQuery` verify clean against a
mechanical play-out. Scry's keep-cost closes a loop: keeps consume draws, draws
determine triggers, triggers determine windows, windows determine keeps. A
product of hypergeometrics cannot express that; it requires a sequential
formulation, which is the exact DP.

**Conclusion for the hard corner:** scry with bricks and OR stays on the exact DP
(11-26s, worker territory). The 74x was never available for scry -- it was
available for free-window effects, and scry does not have free windows. Anyone
picking this up again should not re-attempt a factorized closed form for
keep-costing effects without first explaining how it escapes this loop.

### The scry defect is a shift in EFFECTIVE DRAWS, not a probability distortion (2026-07-30)

Best result of the scry investigation, and it came from reframing the question as
"is the defect a constant offset in some transformed space" rather than "how big
is the error".

Sound reasoning that got there, worth keeping: with NO keeps the method is exact,
because bottoming a useless card and free-drawing it are indistinguishable --
either way it is gone from the library and satisfies nothing. Keeps are the only
defect. But the defect is not the DELAY (that is already modelled by subtracting
kept cards from available draws) and not cascading (both the method and the exact
DP exclude it, so it cancels). It is that the delay FEEDS BACK on trigger count:
draws spent collecting known cards do not reveal new library cards, so fewer
copies are found, so fewer windows open.

Measured by inverting the exact curve to find the shift d with
`method(n) = exact(n + d)`, monotone query, 60-card deck, look 3:

| copies | d at n=8 | 10 | 12 | 15 | 18 | 22 |
|---|---|---|---|---|---|---|
| 2 | 0.098 | 0.099 | 0.100 | 0.102 | 0.105 | 0.110 |
| 4 | 0.186 | 0.188 | 0.191 | 0.195 | 0.200 | 0.209 |
| 8 | 0.336 | 0.342 | 0.347 | 0.355 | 0.363 | 0.378 |

`d` is nearly FLAT in n (~10% drift over n=8..22) and linear in copies. Against
expected keeps it is cleaner still: `d/keeps` is constant across copy counts at
fixed n (0.41 / 0.40 / 0.40 at n=15 for 2/4/8 copies), and

  **d * n / keeps = 5.6, 5.8, 5.9, 6.0, 6.3, 6.6** at n = 8, 10, 12, 15, 18, 22

stable within +-10% over all 18 data points, with 6 = 2 * (look size 3). So
`d ~= 2S * keeps / n`: keeps steal a fraction keeps/n of the fresh draws, and each
lost fresh draw costs the window it would have found.

Why this is worth more than the earlier `1.3 * copies * P(1-P)` fit: that was the
same effect seen through the curve's slope, hence the arbitrary constant. This
one corrects the model's INPUT -- evaluate the method at `n - d` -- which is
defensible and needs no probability-space fudge. Expected residual is the +-10%
coefficient drift, ~0.035 draws, which at a typical slope of 0.02/draw is ~0.07pt,
inside the 0.1pt bar.

TO VALIDATE before trusting: whether `d * n / keeps ~= 2S` holds for other look
sizes (only S=3 measured, so the 2S reading may be coincidence), other deck
sizes, and the BRICK queries -- those were excluded here because their curve is
non-monotone and cannot be inverted, so they need the correction applied directly
and the residual measured instead.

### ...and why the effective-draws correction still does not reach the hard corner (2026-07-30)

Validated the `d ~= 2S * keeps / n` correction beyond the family it was fitted
on. It fails twice.

| config | raw error | after correction |
|---|---|---|
| 60c S=1 monotone | 0.385pt | 0.225pt (better) |
| 60c S=2 monotone | 0.647pt | 0.129pt (better) |
| 60c S=4 monotone | 0.773pt | **-0.439pt** (overshoots) |
| 40c S=3 monotone | 1.032pt | **-0.495pt** (overshoots) |
| 60c S=2 BRICK | 1.292pt | **1.597pt** (worse) |
| 60c S=3 BRICK | 1.742pt | **2.478pt** (worse) |
| 40c S=3 BRICK | 2.494pt | **3.788pt** (worse) |

1. **`2S` was a coincidence of S=3 / N=60.** It overshoots at S=4 and at N=40, so
   the true coefficient depends on look size and deck size in a way that was not
   characterized. Anyone re-deriving it should note that `d*n/keeps = 2S` is
   TRUE BY CONSTRUCTION once d is defined that way -- that identity is circular
   and must not be mistaken for confirmation, which it briefly was here.
2. **Wrong sign on non-monotone queries, structurally.** Fewer effective draws
   HELPS a brick query (less chance of drawing the brick), so shifting n down
   pushes the estimate further up -- the same direction as the existing error.
   The correction therefore cannot work where the curve is not increasing in
   draws, which is exactly the hard corner.

Net for the whole scry line of attack: the reframing was a real insight about the
MONOTONE regime (the defect there is a shift in effective draws, flat in n and
linear in copies, and a correction gets within ~0.13-0.23pt), but the hard corner
is non-monotone by definition and stays on the exact DP. Three separate fast-path
attempts have now failed on it -- pooled-budget max, cap bumping, and
effective-draw correction -- each for a different and now-documented reason.

### Extreme look sizes: the method gets WORSE, not better (2026-07-30)

Tested S from 1 up to nearly the whole deck (N=20, A=4, brick=2, 2 copies, 6
draws). Prediction going in was that error would VANISH at large S, since once
you have seen the whole deck extra triggers are worthless. Wrong.

| S | monotone exact | method | err | brick exact | method | err |
|---|---|---|---|---|---|---|
| 1 | 0.383 | 0.391 | 0.81pt | 0.221 | 0.227 | 0.63pt |
| 4 | 0.503 | 0.546 | 4.36pt | 0.301 | 0.335 | 3.35pt |
| 8 | 0.604 | 0.673 | 6.87pt | 0.377 | 0.426 | 4.84pt |
| 16 | 0.638 | 0.716 | **7.75pt** | 0.441 | 0.459 | 1.72pt |
| 18 | 0.638 | 0.716 | 7.75pt | 0.451 | 0.564 | **11.36pt** |

Why the prediction failed: extra triggers do become worthless, but KEEPS become
maximal -- at large S you always find exactly what you need and keep it, so the
keeps-steal-draws defect is at its strongest. The exact model needs the cantrip
drawn early enough to still have draws left to collect those keeps; the method's
draw-shaped trigger accounting over-credits late cantrips.

The exact column behaving as expected is worth noting: it saturates once the look
size covers the reachable POOL (deck minus copies), after which more looking adds
nothing and success becomes purely draw-gated. Correcting a misreading in the
first version of this entry: saturation is at S >= 16 here, not S=12 -- at S=12
the value is still climbing (0.63745 against the saturated 0.63844). The
threshold is the pool size, not the deck size. Either way the DP passes the
extreme-case sanity check while the fast method does not.

**A separate BUG surfaced:** the brick row jumps 1.72pt (S=16) -> 11.36pt (S=18),
a discontinuity rather than a trend. When `n + t*S` exceeds the deck the windows
are TRUNCATED and `slotDistribution` caps `seen` at deck size, so recovering the
trigger count as `t = round((seen - n)/S)` breaks. Any future use of that
inversion needs to handle truncated windows explicitly.

Practical upshot: the fast method is weakest precisely where look sizes are large
("look at the top 7" style effects), on top of the non-monotone sign problem. It
remains valid only for capped-keep effects (impulse), which is where it shipped.

### Terminology (because it kept getting muddled)

- **exact DP** -- `exactSelectionCurveDnf` / `...And` / `...SingleGroup` in
  selection.ts. Sequential dynamic program, one card at a time, state = (pool
  composition, cards in hand, draws left, window credits), optimal play by
  backward induction. Exact; the reference implementation.
- **slot DP** -- `slotDistribution` / `exactDrawCurve`. Tracks only WHERE triggers
  land and no card composition, which is what makes draw-shaped effects cheap and
  cacheable. Powers the live cantrips card.
- **modified-query method** (sometimes sloppily called "the closed form" in later
  entries -- prefer this name) -- `modifiedQuery.ts` for impulse,
  `modifiedQueryScry.ts` for scry. `hold = seen - ditched`: whatever a look effect
  made you let go simply shifts the query, so enumerate what the windows contained,
  shift the bounds, weight hypergeometrically, average. Computed by FORMULA rather
  than by stepping through the process, which is what "closed form" was gesturing
  at -- though it is not a single expression, so the name misleads.
- **per-trigger recursion** -- `triggerRecursion.ts`. Answers the question "where is
  the next cantrip?" repeatedly: find it within the remaining draws (negative
  hypergeometric), resolve its window, spend the draws its kept cards cost, remove
  the window from the pool, recurse for the one after. Stops when no cantrip remains
  within the draw budget, and the leftover draws are scored by ordinary
  hypergeometry. SEQUENTIAL, which is why each trigger knows its own position --
  that is what removed the position corrections the modified-query method needed.
- **cheap tail** -- `cheapTail.ts`. A formula for the END of a bounded query
  ("tail" = the final stretch). Once every piece you needed is in hand, nothing is
  worth keeping, so the only open question is whether a brick reaches your hand
  before the game ends. No keeps means no draws are spent collecting, so the rest of
  the process is plain draw-and-bottom and collapses to: how many bricks are among
  the cards you will see, and did each land in a slot you DRAW from (bad) or one a
  cantrip BOTTOMS (harmless). "Cheap" because it replaces a recursion with a
  formula.
- **brute force** -- `bruteSelection.ts`. Plays out every distinct deck ordering
  with real mechanics; `bruteSelectionUpperP` is the clairvoyant variant used to
  bound optimizers. Test-only, limited to ~12-card decks.

### The stacked-deck oracle: the DP's strongest validation yet (2026-07-30)

Construction: fill every non-query slot with a scry-100 cantrip. Then for a query
needing T pieces, the answer is known analytically -- P equals the NO-SCRY base
rate for n <= T, and exactly 1 for n >= T+1. Reasoning: below the threshold,
spending a draw to cast the cantrip costs precisely the draw you needed, so
selection cannot help; at T+1 every ordering wins, because a cantrip stacks the
deck and the remaining draws collect the pieces.

**The exact DP passes all 26 checks across four deck configurations to 1e-9**,
including the sharp discontinuity at exactly T+1 and the six-decimal base-rate
match below it. This probes a regime the brute force cannot reach (look size 100,
deck stuffed with cantrips) against an analytically known answer, so it shares no
implementation with the thing under test. It simultaneously confirms three
mechanics: kept cards really do cost draws, bottomed cards really do leave the
pool, and the optimal-play max really does find the stack-the-deck line.

**It also exposed a bug in the modified-query method** -- correct everywhere
except at exactly n = T, where it returns 1.000000 against a base rate of 0.0316
and 0.0035 (errors of 96.8pt and 99.7pt). Cause: at n = T the method draws the
cantrip (one draw), keeps T pieces, and computes `sched - spent = -1`, which
clamps to 0 while the kept cards stay SECURED -- crediting keeps there were never
draws to collect. The DP avoids this structurally (`taken = min(a, min(keepMax,
d))`).

Note the earlier no-keeps test could not have caught this: with no keeps, clamping
never fires. Two tests, two disjoint blind spots.

Capping keeps at available draws fixes the oracle case, but is INERT for the
general error (+0.819pt stays +0.819pt, +2.516pt stays +2.516pt at n=15), because
`spent > sched` essentially never occurs at ordinary look sizes. So the method has
two independent defects: a clamping bug that is catastrophic when it fires and
invisible otherwise, and the trigger-feedback error that is always present and
still unfixed.

### Fixed-point iteration: the loop IS solvable, and my obstruction claim was wrong (2026-07-30)

Retraction first: I called the keeps/triggers coupling a structural obstruction on
the grounds that a one-shot joint lost 5-8% of its probability mass. That was an
artifact of solving the loop in one shot, not evidence that it cannot be solved.

The coupling -- keeps consume draws, so fewer fresh cards are revealed, so fewer
copies are found, so fewer windows open, so fewer keeps -- is a FIXED POINT in a
small discrete space, and iterating it converges in 7-10 passes:

| case (60c, look 3, 15 draws) | one-shot | fixed point | mass |
|---|---|---|---|
| 1 clause, no brick, 4 copies | 0.560pt | 0.428pt | 1.000000 |
| 1 clause, no brick, 8 copies | 0.759pt | 0.470pt | 1.000000 |
| 1 clause + brick, 4 copies | 0.819pt | 0.652pt | 1.000000 |
| 1 clause + brick, 8 copies | 1.742pt | 1.146pt | 1.000000 |
| OR + brick, 4 copies | 1.047pt | 0.743pt | 1.000000 |
| OR + brick, 8 copies | 2.516pt | 1.376pt | 1.000000 |

Mass is exactly 1 throughout, because the iteration COMPOSES two proper
distributions (slot structure at `n - keeps`, then window contents) rather than
constructing a new joint. Error falls 25-45%. Also folded in the clamping fix
(keeps capped at draws actually remaining), which the stacked-deck oracle
demanded.

**Remaining residual, and the diagnosis:** the iteration converges on E[K], a
single mean, and feeds that into the slot distribution. The map from keeps to
probability is nonlinear, so `f(E[K]) != E[f(K)]` -- a mean-field/Jensen bias
whose size should grow with the SPREAD of K. That matches the data: the residual
is worst at 8 copies in every row.

**Next step, unattempted:** stop collapsing K to its mean. Enumerate K's
distribution, weight each branch by P(K), and use `slotDistribution(n - K)` per
branch. Same weighted-average principle the whole method rests on, applied one
level up, and mass-preserving by the same argument. If that lands the worst case
near 0.1pt, the method covers scry and the hard corner gets a fast path.

### The residual is NOT a mean-field bias (2026-07-30)

Predicted that the ~1.4pt residual came from iterating the trigger/keeps fixed
point on E[keeps] rather than on the distribution of keeps -- a Jensen bias, since
probability is nonlinear in keeps. Implemented the distribution-level version
(each candidate keep-count carries its own weight and its own slot distribution at
`draws - K`) and measured:

| case (60c, look 3, 15 draws) | raw | mean-field | distribution | dist time |
|---|---|---|---|---|
| 1 clause, no brick, 4 copies | 0.560pt | 0.428pt | 0.427pt | 616ms |
| 1 clause, no brick, 8 copies | 0.759pt | 0.470pt | 0.467pt | 3.6s |
| 1 clause + brick, 8 copies | 1.742pt | 1.146pt | 1.147pt | 3.0s |
| OR + brick, 8 copies | 2.516pt | 1.376pt | 1.380pt | 10.4s |

Differences of 0.001-0.004pt, i.e. nothing, for 3-10x the cost (the OR case ends
up only 2.3x faster than the exact DP, which defeats the point). Prediction wrong:
the keep distribution sits on {0,1,2} and the map is not nonlinear enough over
that range for the mean to lose anything. Variant deleted, finding kept.

**What the residual must be instead: cross-window timing.** All windows are pooled
into one composition and one keep decision, so a keep from a window that resolved
AFTER the draws were spent is still credited. Note the composition sampling itself
is sound -- conditional on the window contents the remaining pool genuinely holds
`counts - window`, which is exactly why the no-keeps case is exact to floating
point. The unjustified step is treating every window as resolving before every
draw. This was the first hypothesis of the session, abandoned too early because
the partition argument appeared to rule it out; that argument only ever justified
the composition sampling, not the keep timing.

Next attempt, if resumed: condition on trigger POSITIONS (distribute the triggers
among the scheduled draws) and credit each window's keeps only against the draws
that follow it. Cost estimate ~1.4k position splits at 4 triggers over 15 draws,
so it will spend much of the remaining speedup -- but unlike the two corrections
already in, it targets the mechanism that is actually left.

### Running the standard table corrected two of my own claims (2026-07-30)

First use of the standard validation format (CLAUDE.md #23) on the scry method,
and it invalidated two things I had been repeating for several turns.

**1. The worst case is low DRAW counts, not the OR+brick corner.** I kept calling
OR+brick (+1.38pt) the worst because it was the configuration I kept re-testing.
Sweeping the extremes of every error-scaling parameter shows 8 copies of a look-3
over 6 draws at **+2.61pt** -- nearly double. Obvious once seen: with few draws,
keeps consume a large FRACTION of them.

**2. The method is not a fast path.** The both-times column shows it slower than
the exact DP in four of five heavy configurations -- 3351 vs 181ms, 4469 vs 392ms,
2310 vs 134ms, 2583 vs 1107ms -- and faster only on OR+brick (5533 vs 21931ms).
The "74x faster" figure quoted earlier was the SINGLE-PASS version measured
against the DP's single worst configuration. The fixed point costs 7-12 passes,
and that corner happens to be cheap for the method while being the most expensive
one for the DP. Comparing a candidate's best config against a reference's worst is
precisely the error the standard was written to prevent, and it caught mine on the
first run.

Full table (60-card deck, A=10/B=6/brick=4 unless noted):

| config | exact | method | d | verdict | cand | ref |
|---|---|---|---|---|---|---|
| degenerate, 0 copies | 0.646312 | 0.646312 | +0.000pt | EXACT | 4ms | 2ms |
| no-keeps | 0.399028 | 0.399028 | +0.000pt | EXACT | 399ms | 222ms |
| copies=1 | 0.671610 | 0.674011 | +0.240pt | OUT | 38ms | 15ms |
| copies=8 | 0.814440 | 0.824312 | +0.987pt | OUT | 3351ms | 181ms |
| look=1 | 0.715907 | 0.722088 | +0.618pt | OUT | 471ms | 93ms |
| look=5 | 0.870841 | 0.878785 | +0.794pt | OUT | 4469ms | 392ms |
| draws=6 | 0.374822 | 0.400914 | **+2.609pt** | OUT | 2310ms | 134ms |
| draws=20 | 0.984207 | 0.985199 | +0.099pt | **WITHIN BAR** | 3033ms | 249ms |
| 1 clause + brick | 0.303473 | 0.314931 | +1.146pt | OUT | 2583ms | 1107ms |
| OR + brick | 0.332260 | 0.346023 | +1.376pt | OUT | 5533ms | 21931ms |
| oracle (stacked deck) | 0.031579 | -- | -- | REFUSED | -- | -- |

Mass is exactly 1.000000 on every row, and the method never comes in under the
reference, consistent with it being a relaxation.

**Consequence for the plan:** the scry fast path is not merely inaccurate, it is
mostly not fast. Any further work on it needs to beat the exact DP on cost in
configurations that are not the DP's worst case, which the fixed-point version
does not. The remaining accuracy lead (cross-window timing) would also make it
slower still. Worth weighing against simply running the exact DP in a worker.

### Recovering the scry method's speed: convergence was paying for discarded work (2026-07-30)

The previous entry reported the method as slower than the exact DP nearly
everywhere, which was true as implemented but not intrinsic. Diagnosis: a single
pass costs ~370ms, the fixed point ran 10 iterations of a FULL pass, and warm
repeats did not help -- so it was not slot-distribution cache misses, just
iteration count.

The fix follows from what the iteration is actually converging: KEEPS, which
depend only on the window composition and the draws available to collect them,
never on the query's probability. So every iteration but the last was computing
`evaluate()` calls it threw away. Convergence now runs with the query evaluation
skipped, followed by one full pass at the converged keep count. **Values are
bit-identical; cost drops ~10x (3827ms -> 383ms).**

Corrected cost profile -- and this is the right shape for a supplement:

| config | method | exact DP | |
|---|---|---|---|
| OR + brick | 375ms | 15327ms | 41x faster |
| 1 clause + brick | 215ms | 635ms | 3x faster |
| monotone, 8 copies | 290ms | 146ms | 2x slower |
| monotone, 6 draws | 248ms | 75ms | 3x slower |

Faster exactly where the exact DP is expensive, slower where the DP is already
cheap. The report test now asserts that shape (>=10x on the corner) rather than
the earlier "not a fast path" claim.

Accuracy is unchanged by any of this: still 8 of 10 configs outside the 0.1pt bar,
worst +2.61pt at low draw counts.

### The impulse method's shipped accuracy claim was cherry-picked too (2026-07-30)

Ran the standard table on `modifiedQuery.ts` (the shipped impulse path). It had
been documented as "+0.02pt, comfortably inside the 0.1pt bar" -- a figure taken
from the OR-plus-brick configuration alone, which is the same cherry-picking error
as the scry speed claim, this time in shipped documentation.

| config | exact | method | d | verdict | cand | ref |
|---|---|---|---|---|---|---|
| degenerate, 0 copies | 0.646312 | 0.646312 | +0.000pt | EXACT | 2ms | 1ms |
| keepMax >= look (no ditching) | 0.837712 | 0.837712 | +0.000pt | EXACT | 5474ms | 129ms |
| need=1 | 0.978245 | 0.978245 | -0.000pt | EXACT | 3744ms | 118ms |
| copies=1 | 0.674007 | 0.674007 | +0.000pt | EXACT | 31ms | 10ms |
| copies=8 | 0.829658 | 0.835123 | +0.546pt | OUT | 3100ms | 140ms |
| look=2 | 0.787851 | 0.790734 | +0.288pt | OUT | 1908ms | 83ms |
| look=5 | 0.880130 | 0.887500 | +0.737pt | OUT | 3774ms | 158ms |
| draws=6 | 0.407866 | 0.415367 | **+0.750pt** | OUT | 2313ms | 47ms |
| draws=20 | 0.986172 | 0.986992 | +0.082pt | WITHIN BAR | 3230ms | 156ms |
| 1 clause + brick | 0.289097 | 0.289827 | +0.073pt | WITHIN BAR | 1486ms | 630ms |
| OR + brick | 0.302373 | 0.302592 | +0.022pt | WITHIN BAR | 3070ms | 14467ms |
| oracle impulse-100, at threshold | 1.000000 | 1.000000 | +0.000pt | EXACT | | |
| oracle impulse-100, below threshold | 0.000000 | 0.000000 | +0.000pt | EXACT | | |

Four EXACT rows are real results and worth keeping: no copies, `keepMax >= look`
(nothing is ever ditched), `need=1` (never more than one missing piece, so impulse
IS draw), and a single copy.

Impulse has its own analytic oracle, distinct from scry's: impulse keeps are FREE
(straight to hand), so with unlimited look every cast yields one chosen piece and
P jumps to 1 at exactly `n = T` -- where scry needs `T+1`, because scry keeps cost
a draw to collect. Both oracle rows pass. Note the at-threshold row alone does not
discriminate (the true answer is 1.0, which is also what a broken trigger
inversion returns -- precisely how the scry bug hid), so the below-threshold row
where the answer is 0 was added alongside it.

Corrected summary: trustworthy where it is USED (bounded queries, which are the
expensive ones for the DP), out of bar on plain monotone queries by up to 0.75pt,
and slower than the exact DP everywhere except the OR-plus-brick corner.

### The scry residual is TRIGGER POSITION, and one copy becomes exact (2026-07-30)

Prompted by the obvious question the standard table raised: why is the simplest
case -- one copy, monotone `A>=2` -- out of bar at all? It should be exact.

It is, once trigger position is respected. The method caps keeps at
`draws - triggers`, assuming every draw after a cast can collect them. But a copy
drawn on the LAST draw has none left, one drawn second-to-last has one, and so on.
Averaging over positions without that cap credits keeps that were never
collectable -- a consistent overestimate.

| config | shipped method | with position conditioning |
|---|---|---|
| deck=60 A=10 need=2 look=3 draws=12 | +0.240pt | **0.000pt** |
| deck=60 A=10 need=2 look=5 draws=12 | +0.370pt | **0.000pt** |
| deck=40 A=8 need=2 look=3 draws=10 | +0.436pt | **-0.000pt** |
| deck=60 A=10 need=3 look=3 draws=15 | +0.252pt | **0.000pt** |

Exact, not merely closer. Pinned in `modifiedQueryScry.position.test.ts`.

**This retires the "cross-window timing" diagnosis** recorded in the previous two
entries. The defect appears with a SINGLE window, so it is not windows
interacting or crediting each other's draws. The composition sampling remains
sound (conditional on window contents the remaining pool really does hold
`counts - window`, which is why the no-keeps row is exact). Only the
collectable-draw cap is wrong, and it is wrong per-trigger:
`collectable = draws - position`, not `draws - triggers`.

Why this lead is better than the previous ones: it is exact rather than improved,
it is a local change (a position-dependent cap) rather than a reformulation, and
there is cost headroom -- the corner runs 601ms against the DP's 20115ms, so
paying a factor of ~n for position enumeration still lands far under the
reference.

Open: multi-copy. Positions interact, since collecting the first trigger's keeps
shifts when the second copy is drawn -- the same feedback the fixed point handles
in aggregate, so it probably needs position conditioning inside the iteration.
Expect trickle-down: the sweep rows all involve keeps, so every one of them should
move.

### Trigger-position conditioning applied: every row improved, three pins moved (2026-07-30)

Applied to the module, capping keeps by the draws that follow a cast rather than by
`draws - triggers`. Exact position enumeration is combinatorial beyond one
trigger, so this conditions on the EARLIEST trigger's position, whose marginal is
closed-form (`C(draws-p, t-1)/C(draws, t)`). Exact at one copy; optimistic above
it, since keeps belonging to a later trigger have fewer draws behind them than the
first.

| case | before | after |
|---|---|---|
| no copies | +0.000 EXACT | +0.000 EXACT |
| nothing ever kept | +0.000 EXACT | -0.000 EXACT |
| one copy | +0.240 OUT | **-0.011 WITHIN BAR** |
| many copies | +0.987 OUT | +0.606 OUT |
| smallest look | +0.618 OUT | +0.493 OUT |
| largest look | +0.794 OUT | **+0.180 OUT** |
| fewest draws | +2.609 OUT | **+1.054 OUT** |
| most draws | +0.099 WITHIN | +0.077 WITHIN |
| one clause + bound | +1.146 OUT | +1.085 OUT |
| OR + bound | +1.376 OUT | +1.302 OUT |

Every row improved or held. The two degenerate rows stayed exact, which is the
invariant that matters: they have no keeps, so the cap must never apply to them.

**Three consequences, all real movement rather than regression:**

1. **The worst case moved** from the fewest-draws sweep (+2.609pt) to the OR
   corner (+1.302pt), so the pin asserting the former had to change.
2. **It is no longer a strict upper bound.** One copy now comes in slightly UNDER
   (-0.011pt). Diagnosis: position conditioning and the fixed point OVERLAP at low
   copy counts, because keeps happen after a trigger and therefore cannot reduce
   the chance of drawing THAT copy -- only later ones. The single-copy prototype
   without the fixed point is exactly 0.000, so the fixed point is spurious there.
   Assertions in three files assumed one-sided error and now bound both directions.
3. **Cost rose ~10x** (corner 601ms -> 7508ms) because the position loop sits
   inside the window enumeration. Still 3.1x faster than the exact DP on the corner
   (7508ms vs 23543ms) but the margin fell from ~40x. The caps depend only on
   position and kept counts, not on the full window composition, so hoisting the
   loop outside should recover most of it -- the obvious next step.

Next leads, in order: hoist the position loop (pure speed, no accuracy change);
make the fixed point apply only to copies AFTER the first trigger, which should
remove the overlap and may restore exactness at low copy counts; then consider
conditioning on later trigger positions for the remaining over-credit.

### Making one copy exact made six rows worse: two errors were cancelling (2026-07-30)

Chased the obvious question -- why is one copy only WITHIN BAR (-0.011pt) rather
than EXACT? Two defects, and fixing the second exposed the first at full size.

**Defect (provably wrong in isolation):** the fixed point deducted the whole keep
total from the trigger opportunities, feeding `slotDistribution(draws - keeps)`.
But keeps happen AFTER a cast, so they cannot affect the copy that caused them.
With a single copy at library position p, `keeps <= draws - p` guarantees
`p <= draws - keeps`, so the copy is drawn whenever `p <= draws` and the deduction
must be ZERO. Only keeps collected BEFORE a trigger can stop you reaching it; with
`t` triggers in uniform order that is `keeps*(t-1)/(2t)` on average.

One copy is now EXACT. Every other row got worse:

| case | before | after |
|---|---|---|
| one copy | -0.011 | **+0.000 EXACT** |
| many copies | +0.606 | +0.978 |
| smallest look | +0.493 | +0.464 |
| largest look | +0.180 | +0.902 |
| fewest draws | +1.054 | +1.466 |
| most draws | +0.077 (in bar) | +0.139 (out) |
| one clause + bound | +1.085 | +1.527 |
| OR + bound | +1.302 | **+2.138** |

**Why: the spurious deduction was masking the first-trigger cap's optimism.**
Capping ALL keeps by the FIRST trigger's position is optimistic, because keeps
belonging to a later trigger have fewer draws behind them. Over-deducting trigger
opportunities pushed values down by roughly the same amount, and the two errors
cancelled at moderate copy counts. The remaining over-credit was always this
large; it simply could not be seen.

Kept the fix rather than reverting. It is correct in isolation, and restoring a
known-wrong term to flatter the table is the compensating fudge these conventions
exist to prevent. Recorded so nobody reads the worse numbers as a regression.

**Next, and now clearly the single remaining mechanism:** cap keeps PER TRIGGER
rather than by the first. Exact position enumeration over t triggers is
combinatorial, but the per-trigger marginals are closed-form order statistics
(`C(p-1,i-1)*C(draws-p,t-i)/C(draws,t)` for the i-th of t), so each trigger's
keeps can be capped by its own expected remaining draws without enumerating the
joint. That should remove the last over-credit, and one copy must stay exact
under it, since a single trigger is its own first and last.

### Next: a natively hypergeometric trigger layer for the scry method (scoped, not started)

Both remaining defects live at one seam: the method borrows `slotDistribution`,
which is the DRAW-shaped slot DP, whose core assumption (windows are free, so the
trigger count cannot depend on keeps) is exactly what scry violates. Everything
bolted on since has been a patch to that mismatch:

- `precedingKeeps(k, t) = k*(t-1)/(2t)` -- a SCALAR stand-in for "keeps before a
  trigger stop you reaching it". Uniform across triggers, so the first is
  over-penalised (true deduction: zero) and the last under-penalised.
- `firstTriggerPosition` -- bolted on because the slot DP reports HOW MANY
  triggers, never WHERE, so every keep is capped by the earliest trigger's
  position and later triggers get credited draws they never had.

These two errors were partly cancelling until 2026-07-30; removing the spurious
one exposed the other at +2.138pt.

**Preferred formulation (2026-07-30), which is the same recursion framed more
usefully:** a trigger requires the cantrip IN HAND, which is `hold = seen -
ditched` applied to the cantrip group itself. So the cantrip stops being special
machinery and becomes just another tracked group, and the SAME query-shift and
offset logic that handles resource groups computes how many triggers there are.
`P(nth cantrip)` is the CDF of the negative-hypergeometric gap below -- the same
object from the other side -- but this framing recycles machinery that already
exists and is already verified instead of introducing a new distribution.

What it must carry explicitly: the DRAW BUDGET between steps. `P(cantrip within n
cards)` says whether, not when, and the keep cap needs when. Sequencing each step
supplies it -- find the first cantrip, resolve its window, spend `kept` draws and
remove the window from the pool, THEN ask for the next cantrip within the draws
that remain. Position never has to be enumerated, because each step consumes a
known budget before the next search, and that is exactly what removes both
`precedingKeeps` and `firstTriggerPosition`.

Both existing exactness invariants then hold BY CONSTRUCTION rather than by luck:
one copy is a single step, reducing to the already-exact prototype; `nothing ever
kept` spends no draws at any step, reducing to the plain curve.

Single effect type only, which matches the whole scry path today. Multi-type is
already solved for draw-shaped effects (`slotDistributionMulti`, used by the live
cantrips card), so there is a precedent to follow.

**Mechanism: a per-trigger recursion with closed-form hypergeometric
transitions.** Not card-by-card (that is the exact DP) but trigger-by-trigger,
and `t <= copies`, so roughly ten steps. The primitive is the NEGATIVE
hypergeometric: given `c` copies among `m` pool cards, the number of non-copy
cards drawn before the next copy is closed-form.

Recursion over `(draws spent, copies left, pool left)`:
1. draw the gap to the next copy (negative hypergeometric on the current pool);
2. if `spent + gap >= draws`, no further trigger -- terminate, and the remainder
   is a plain hypergeometric;
3. otherwise the trigger's POSITION is known, so its keep cap is `draws - position`
   exactly -- no first-trigger stand-in;
4. enumerate that window's composition (hypergeometric on the current pool),
   compute `kept`, spend `kept` draws, remove the whole window from the pool;
5. recurse.

Why this removes both patches rather than improving them: every trigger carries
its own position (so `firstTriggerPosition` is unnecessary), and keeps spent in
steps 1-4 have already reduced the budget before the next gap is drawn, so
"future triggers never happening" becomes a consequence instead of a scalar
correction (`precedingKeeps` is unnecessary). There is also no fixed point to
solve, because nothing needs to agree with itself in the mean.

**Mass is 1 by construction** -- a sequential decomposition of the permutation,
each configuration reachable exactly one way. That is the property the earlier
one-shot joint lost (0.92-0.99) and the reason a fixed point was needed at all.

Subtlety that must not be fumbled: gaps are measured in LIBRARY POSITIONS, and
window cards consume library positions without consuming draws. Step 5 reduces
the pool by the whole window but the draw budget only by `kept`. Conflating those
is precisely the trigger over-count this replaces.

Invariants it must preserve, both already in the suite: one copy stays EXACT
(a single trigger is its own first and last), and `nothing ever kept` stays EXACT
(no keeps, so no budget interaction). Worth writing as a fresh module rather than
patched into `scryModifiedQueryPass`, since it replaces the trigger layer wholesale.

### Forward mass propagation ("wave function collapse"): exact, but not faster (2026-07-30)

Proposed as an alternative framing: give each draw a distribution over group
counts, collapse into distinct states, advance each, weighted-average. That IS
dynamic programming with state merging, so as stated it converges back to
`exactSelectionCurveDnf` -- whose state is exactly (pool per group, hand per group,
draws left, credits) and which already applies the lossy collapses worth having
(saturating hand counts at the threshold, folding satisfied unbounded groups into
filler, absorbing success and dead clauses).

The real idea underneath it is DIRECTION. The DP is BACKWARD (value function from
the horizon); the proposal is FORWARD (mass pushed out from the opening hand).
Forward carries probability mass explicitly, which unlocks something backward
induction cannot do: error-bounded pruning with a rigorous interval.

Implemented as `forwardScry.ts` (test-only) and measured:

| case (deck 60, 8 copies) | forward, eps=1e-9 | backward DP | interval |
|---|---|---|---|
| one group, 12 draws | 222ms | 195ms | +0.0018pt |
| one group, 6 draws | 28ms | 39ms | +0.0002pt |
| one group, look 5 | 380ms | 186ms | +0.0043pt |
| two groups | 412ms | 700ms | +0.0037pt |
| one group, 20 draws | 457ms | 155ms | +0.0045pt |

At eps=0 it matches the DP to floating point on every case. With pruning the
interval is rigorous and tiny. But it is faster only on the two-group row.

**Why it cannot be pushed:** interval width is roughly (pruned states x epsilon),
so keeping it inside the 0.1pt bar with ~50k states caps epsilon near 2e-8, which
removes only 30-35% of states. The mass is not concentrated enough for pruning to
pay, and explicit mass propagation costs more per state than memoised backward
recursion.

**Kept anyway, for a different reason:** it is an INDEPENDENT exact implementation
that works at 60 cards. `bruteSelection.ts` is the strongest check available but
caps out near 12 cards, so until now nothing verified the DP at realistic sizes
except analytic oracles. Forward propagation shares no code with the backward DP
and agrees to 1e-12, which is a validation capability the project did not have.

Scope limit worth remembering: forward propagation cannot take a max over
decisions, since it cannot see future value. Greedy keep is provably optimal for
monotone AND queries, so it is exact there; for OR or upper-bound queries it would
evaluate a fixed policy and yield a lower bound. The expensive corner is exactly
the OR-plus-bricks case, so forward alone could never have covered it.

Returning to the modified-query method and the natively hypergeometric trigger
layer scoped above.

### The per-trigger recursion works: exact AND faster than the DP (2026-07-30)

Implemented the framing scoped above -- a trigger requires the cantrip in hand, so
each step finds the next cantrip within the remaining draws, resolves its window,
spends the kept cards' draws, removes the window from the pool, and recurses.

**Result: exact to floating point, and 2-5x faster than `exactSelectionCurveDnf`.**

| config (deck 60, A=10, need 2) | exact DP | recursion | old closed form | rec ms | dp ms | states |
|---|---|---|---|---|---|---|
| 1 copy, look 3, 12 draws | 0.67160986 | 0.67160986 | +0.000pt | 11 | 8 | 32 |
| 8 copies, look 3, 12 draws | 0.81443970 | 0.81443970 | +0.978pt | **69** | 143 | 722 |
| 8 copies, look 3, 6 draws | 0.37482165 | 0.37482165 | +1.466pt | **6** | 31 | 182 |
| 8 copies, look 5, 12 draws | 0.87084140 | 0.87084140 | +0.902pt | **43** | 126 | 792 |

A prediction of mine was wrong and worth recording: I expected tracking sequence
to force the DP's state space, making this no faster. It does not. The recursion
jumps the gap of fresh draws in ONE hypergeometric step instead of one card at a
time, so there are far fewer levels to memoise -- 32 to 792 states against the
DP's tens of thousands. Sequencing turned out to be cheaper than per-card
transitions, not more expensive.

Both patches are gone, not improved: no `precedingKeeps` (keeps reduce the budget
before the next search, so lost future triggers are a consequence), no
`firstTriggerPosition` (each trigger's position falls out of its own step). No
fixed point either, since nothing has to agree with itself in the mean.

Committed as `triggerRecursion.ts` with ten tests, including the two exactness
invariants (no copies reduces to plain hypergeometry; one copy exact) and
monotonicity in draws and copies.

**Scope, and the work that remains:** single tracked group, monotone `>=` query,
one effect type. Greedy keep is provably optimal there, which is why no max over
decisions appears. Upper bounds (bricks) and OR clauses need that max -- and they
are the expensive corner, so extending this is now the highest-value next step:
if it stays exact and fast with bounds and OR, it supersedes both the closed-form
method AND the DP for scry rather than supplementing them.

### Bricks and OR in the recursion: accuracy good, but bounds invert the speed win (2026-07-30)

Extended `triggerRecursion` to several groups, upper bounds and an OR of clauses,
with a GREEDY keep rule first as agreed.

| case (deck 60, look 3, 8 copies) | exact DP | recursion | d | rec ms | dp ms | states |
|---|---|---|---|---|---|---|
| `A>=2 & brick<=0`, 15 draws | 0.30347254 | 0.30211318 | **-0.136pt** | 5707 | 727 | 31606 |
| `A>=2 & brick<=0`, 8 draws | 0.34906578 | 0.34809744 | -0.097pt | 316 | 247 | 5863 |
| `A>=2 & brick<=2`, 15 draws | 0.88298364 | 0.88268911 | -0.030pt | 13523 | 1829 | 70711 |
| `(A>=2) \| (B>=2)`, 12 draws | 0.91857408 | 0.91760257 | -0.097pt | **362** | 880 | 1736 |
| OR + brick, 15 draws | 0.33226013 | 0.33037661 | **-0.188pt** | 115527 | 16324 | 185724 |

**Bricks needed no query editing**, unlike the closed-form method: the recursion
tracks what is in hand, so a bottomed brick never enters `acq`, and greedy refuses
it automatically because a brick is never "needed".

**Greedy costs 0.03-0.19pt, always NEGATIVE** -- the signature of a suboptimal
policy, since a fixed policy can only lose against the optimum. Two rows land
inside the 0.1pt bar, three do not. A max over commit vectors would restore
exactness at more cost.

**Bounds invert the speed advantage, as flagged before starting.** Success can no
longer absorb -- satisfied on one draw, busted on the next -- so every branch runs
to the horizon: 5.7s against 0.7s, 13.5s against 1.8s, and 115s against 16s on the
corner. State counts confirm it (31k-186k, against 32-792 for monotone). The one
row that stays fast is the unbounded OR, whose clauses are unbreakable so
absorption still applies.

**Where each tool now wins:**

| regime | best tool | why |
|---|---|---|
| monotone, single group | recursion | exact, 2-5x faster |
| unbounded OR | recursion | 2.4x faster, -0.097pt from greedy |
| any upper bound | exact DP | recursion is 3-7x slower AND inexact |
| OR + bound (the corner) | exact DP | recursion is 7x slower |

So the corner remains the DP's, and for the reason CLAUDE.md #21 already records:
an upper bound removes early exit, and early exit is what every fast method here
has been buying its speed with. Two independent approaches have now hit the same
wall from opposite directions -- the closed form could not express keep timing, and
the recursion cannot absorb success. That is worth treating as a property of the
problem rather than of either implementation.

### Restoring early exit for bounded queries: right idea, wrong wiring (2026-07-30, reverted)

Diagnosis of why bounded queries are 3-7x slower in the recursion: TWO causes, and
only one is intrinsic.

1. An extra group dimension (the brick) multiplies the state space. Unavoidable --
   the pool composition genuinely matters.
2. Absorbing success was removed WHOLESALE, which is overkill. Once every `lo` of a
   clause is met, nothing is needed any more, so no keep can ever happen again --
   and that is exactly the no-keeps regime the closed-form method computes EXACTLY
   (one of its two exact rows). The tail does not need recursing at all.

Attempted: hand the tail to `scryModifiedQuery` at the point where all `lo` bounds
are met. **Reverted -- it hangs.** The handoff fires once per STATE, and each call
runs its own multi-pass fixed point, so ~31k states become tens of thousands of
full sub-computations. Idea sound, wiring catastrophic.

What a correct version needs: the tail depends only on `(rem, remC, remO, d)` and
the residual bounds -- NOT on the path taken to get there, and not on `acq` beyond
the residual. So it must be memoised on that key and computed once per distinct
tail state, not once per visit. Better still, the tail is the same object for many
states, so it could be precomputed as a small table over `(remC, d)` for the
common case of a single brick group.

Worth attempting again with that memoisation, because the accuracy is already
there (-0.03 to -0.19pt from greedy alone) and this addresses the only reason the
recursion loses to the DP on bounded queries.

### Second tail-handoff attempt: memoisation fixed the cost, but the handoff is WRONG (2026-07-30, reverted)

Retried the bounded-query early exit with the two fixes the first attempt needed:
a SINGLE closed-form pass rather than the fixed point (keeps are zero in the tail,
so iterating is pure waste) and MEMOISATION on the tail state (pool, draws left,
residual bounds -- never the path taken).

The memoisation worked: state counts fell to 1388-9708. The handoff itself is
wrong.

| case | recursed tail | handoff |
|---|---|---|
| `A>=2 & brick<=0`, 8 draws | -0.097pt, 316ms | -0.161pt, 7395ms |
| `A>=2 & brick<=0`, 15 draws | -0.136pt, 5707ms | **-1.906pt**, 106744ms |
| `A>=2 & brick<=2`, 15 draws | -0.030pt, 13523ms | **-17.627pt**, 125306ms |

-17.6pt is a broken equivalence, not a policy cost. Slower too, because each
distinct tail state still runs a closed-form pass and there are thousands of them.

**The reasoning error, stated plainly:** "no keeps implies the closed form is
exact" was verified only FROM THE START of the process, with a pure `brick<=0`
query and no lower bounds anywhere. I assumed it transferred to entering
mid-process with an arbitrary remaining pool and a RESIDUAL bound. It does not,
and the failure grows with the draw horizon (-0.16 at 8 draws, -1.91 at 15), which
suggests the tail's trigger accounting diverges the longer it runs rather than a
one-off translation slip.

Do not retry without first testing the equivalence in isolation: take a
mid-process state, compute its continuation with the recursion and with a
closed-form pass on the residual query, and check they agree BEFORE wiring it into
anything. Both attempts so far skipped that step and both failed, in different
ways.

Standing position unchanged: bounded queries are exact-DP territory. The recursion
wins on monotone (exact, 2-5x faster) and unbounded OR (2.4x faster, -0.097pt).

### Bricks as an enumeration constraint rather than tracked state (2026-07-30)

Applied the closed-form spirit -- handle the brick as a constraint instead of state
-- to the recursion's enumeration: a group no live clause tolerates (`hi = 0`
everywhere) can only ever be zero in a surviving path, so fresh-draw branches
containing one are skipped instead of computed and discarded.

Strictly free: identical accuracy to the digit (those branches contribute exactly
zero), less enumeration.

| case | before | after | d (unchanged) |
|---|---|---|---|
| `A>=2 & brick<=0`, 15 draws | 5707ms | 3754ms | -0.136pt |
| `A>=2 & brick<=2`, 15 draws | 13523ms | 12274ms | -0.030pt |
| OR + brick, 15 draws | 115527ms | 90819ms | -0.188pt |

1.3-1.5x, which does not change the verdict: bounded queries remain 5-6x slower
than the exact DP.

**What query editing cannot do, recorded because it was asked for directly and the
reasoning matters:** in the closed-form method, raising a cap by the ditched count
works because that method never tracks state -- the entire seen population is
scored once at the end, so the edit is the only place the information can live. The
recursion already tracks what is in hand, so a bottomed brick simply never enters
`acq` and no edit is needed. What an edit CANNOT do is restore absorbing success:
absorption means returning 1 early, and with `brick<=0` the remaining draws still
carry real brick risk because draws are forced. No cap adjustment removes a risk
that is actually there.

That is now the third independent route to CLAUDE.md #21 -- an upper bound removes
early exit, and early exit is what every fast method here buys its speed with. The
closed form could not express keep timing; the recursion cannot absorb success; and
query editing cannot manufacture absorption. Three mechanisms, one wall.

### Correction: the tail equivalence is EXACT; the earlier conclusion was wrong (2026-07-30)

Two entries above record that handing the bounded tail to the closed form produced
-1.9pt and -17.6pt, and conclude the equivalence itself was broken. **That
conclusion was wrong.** Tested in isolation at last -- the step both attempts
skipped and this file already said to do first -- the closed form is EXACT for pure
upper-bound queries, on six configurations, to floating point:

| pool | brick cap | copies | draws | exact DP | closed form |
|---|---|---|---|---|---|
| 56 | <=0 | 8 | 12 | 0.36960168 | 0.36960168 |
| 56 | <=0 | 8 | 8 | 0.52977211 | 0.52977211 |
| 56 | <=2 | 8 | 12 | 0.97229709 | 0.97229709 |
| 56 | <=1 | 8 | 15 | 0.71107299 | 0.71107299 |
| 40 | <=0 | 6 | 10 | 0.41093117 | 0.41093117 |
| 30 | <=1 | 4 | 8 | 0.83448276 | 0.83448276 |

Pinned as `tailEquivalence.test.ts` so the claim is defended by a test rather than
by prose.

**The real bug** was a group with no upper bound being passed as `hi = rem[g]`.
That looks vacuous and is not: `evaluate` counts ACQUIRED cards, so a bound of
`rem` silently caps what the tail may draw. Passing no `hi` at all fixes it, and
accuracy then matches the recursed version exactly (-0.0968, -0.1359, -0.0295).

**But the handoff still is not worth wiring in**, for a different reason than
claimed before: it is SLOWER. States fall as intended (31606 -> 4248) while each
tail call runs a full closed-form pass -- window enumeration plus many `evaluate`
calls -- which costs far more than the recursion steps it replaces: 4663ms /
61210ms / 135204ms against 316ms / 3754ms / 12274ms. Reverted on cost, not on
correctness.

So the CLAUDE.md #21 framing stands but one leg of it was wrong: query editing CAN
express the bounded tail exactly. What it cannot do is make it cheap. Absorption
under a bound remains available in principle and unaffordable in practice, which is
a weaker and more accurate statement than "three mechanisms, one wall".

### Why the tail handoff was slow, and how to make it cheap (2026-07-30)

Asked how the closed form can be exact and cheap for impulse but not for the scry
tail. It is NOT cheap for impulse either -- from its own report table the closed
form costs 1.5-5.5s per invocation (5474ms against a 129ms DP, 3100ms against
140ms, 3774ms against 158ms) and only looks good in the single row where the DP
costs 14.5s. Called once for a whole query, seconds is acceptable. Called at every
tail state -- 4248 distinct ones after memoisation -- it is fatal. Same computation,
four thousand times the invocations.

**The fix, which was available all along:** the tail is a DEGENERATE case of the
general pass and should not use it. The general pass enumerates each window's
composition because it must decide what to keep. In the tail nothing is ever kept,
so window CONTENTS are irrelevant -- only that the window consumed cards. So the
tail needs:

1. the slot distribution (already cached, query-independent), and
2. per outcome, the probability that every brick in the seen prefix landed in a
   WINDOW slot (bottomed, harmless) rather than a SCHEDULED slot (in hand, busts)
   -- a positional hypergeometric.

A sum over slot outcomes with one closed-form factor each, no nested enumeration
over groups. Exact for the same reason `tailEquivalence.test.ts` passes, and orders
of magnitude cheaper than what was measured.

Recorded rather than implemented. If it lands, the bounded rows flip from 5-6x
slower than the exact DP to faster, and the accuracy is already verified -- the
recursed version's -0.03 to -0.19pt comes entirely from greedy keep, not from the
tail.

Lesson worth keeping beyond this: reusing general machinery for a degenerate case
cost two failed attempts and a wrong conclusion. The tail's defining property --
nothing is ever kept -- is exactly what makes the expensive part of the general
pass unnecessary.

### The cheap tail works: bounded queries from 5-6x slower to ~2x (2026-07-30)

Built `cheapTail.ts` as the degenerate-case computation the last two attempts
should have used, and wired it into the recursion.

**Why it is cheap:** with no keeps, no draw is spent collecting, so the process is
exactly DRAW-SHAPED and `slotDistribution` (cached, query-independent) applies
unchanged. Window CONTENTS are irrelevant -- only that a window consumed cards --
so the composition enumeration that dominates the general closed-form pass
disappears. What remains per slot outcome is the chance that at most `cap` of the
bricks in the seen prefix landed in a SCHEDULED position (into hand, counting
against the bound) rather than a WINDOW position (bottomed, harmless): a positional
hypergeometric.

Verified exact standalone before wiring, per CLAUDE.md #21b: six configurations,
agreement to floating point, at 4-22ms against the DP's 38-100ms, where the general
pass costs seconds for the same answer.

Wired into `triggerRecursionDnf`:

| case | recursed tail | general-pass tail | cheap tail | exact DP | d (unchanged) |
|---|---|---|---|---|---|
| `A>=2 & brick<=0`, 8 draws | 446ms | 4663ms | **359ms** | 131ms | -0.097pt |
| `A>=2 & brick<=0`, 15 draws | 3754ms | 61210ms | **1120ms** | 607ms | -0.136pt |
| `A>=2 & brick<=2`, 15 draws | 12274ms | 135204ms | **2373ms** | 1128ms | -0.030pt |

3.4-5.2x faster than recursing the tail, 13-57x faster than the general pass, and
accuracy identical to the digit -- which confirms the tail contributes no error at
all. The entire remaining residual is greedy keep.

Still ~2x slower than the exact DP, so bounded queries are not yet recursion
territory. Two things would close that:
1. the tail currently handles ONE bounded group; several need the positional split
   generalised to a multivariate form;
2. greedy keep is the only source of error left (-0.03 to -0.14pt, always
   negative), so a max over commit vectors would make the recursion exact -- at
   some cost, which is why they must be measured together.

Bounded OR is not yet wired: the handoff fires only for a single clause, because
with an OR a busted clause can still be rescued by another, so the tail is a union
over clauses rather than one clause's survival.

### Ponder is the CHEAPEST shape in the DP, which narrows what "the corner" is (2026-07-30)

Measured all four shapes on identical queries (deck 60, A=10/B=6/brick=4, look 3,
8 copies):

| query | draw | impulse | scry | **ponder** |
|---|---|---|---|---|
| monotone, 12 draws | 142ms | 102ms | 135ms | **24ms** |
| brick, 15 draws | 62ms | 749ms | 667ms | **21ms** |
| OR + brick, 15 draws | 105ms | 14004ms | 15807ms | **64ms** |

Ponder is 247x faster than scry on the corner, despite being the more complex
effect -- it has a shuffle option and therefore a max over two branches.

**So the corner is not "bounded OR".** It is BOTTOMING. Scry and impulse carry
`nonKeptLeavesPool: true`, so every distinct window composition removes a different
set of cards and spawns a distinct pool state; the state space fans out. Ponder's
window either stays on top or shuffles back, so the pool barely changes and its
transitions jump much further through the draw budget, leaving far fewer levels to
memoise.

Two consequences:
1. **Ponder needs no recursion implementation.** The DP answers it in 64ms on the
   worst query measured all session. Building it would buy nothing.
2. **The expensive corner is narrower than reported throughout this file**: it is
   bottoming + upper bound + OR, not bounded OR in general. Earlier entries saying
   "bounded queries are DP territory" should be read as "bottoming effects with
   bounds are expensive", which is a smaller and more actionable claim.

Also worth noting for modelling sanity: ponder scores HIGHER than scry on the brick
query (0.35467 against 0.30347). Both avoid drawing bricks, but by different means
-- scry bottoms them at the cost of spending draws to collect what it keeps, while
ponder can shuffle a brick-laden top away entirely. The DP is verified against the
brute force for both shapes, so this ordering is a result rather than a suspicion.

### A keep HEURISTIC inside the DP: exact on monotone and 13x faster (2026-07-30)

Suggested: instead of maximising over commit vectors, use a rule -- keep toward the
clause nearest completion, tie-break toward the scarcer group. Tested by adding an
opt-in `heuristicKeep` flag to `exactSelectionCurveDnf` (default stays EXACT).

| case (deck 60, look 3, 8 copies) | exact (max) | heuristic | d | heur ms | exact ms |
|---|---|---|---|---|---|
| monotone, 1 group, 12 draws | 0.81443970 | 0.81443970 | **0.0000pt** | 94 | 165 |
| 2 groups AND, 12 draws | 0.67597599 | 0.67597599 | **0.0000pt** | **63** | 848 |
| brick, 15 draws | 0.30347254 | 0.28116376 | -2.231pt | 221 | 692 |
| OR + brick, 15 draws | 0.33226013 | 0.30025303 | -3.201pt | **1279** | 16552 |

**Finding 1 -- RETRACTED, see the scope entry below.** It looked like a free win on
monotone queries (exact, up to 13x faster). Broadening from 2 configs to 32 showed
it is exact for draw, impulse and ponder but WRONG for scry on 3 of 8 configs,
worst 1.03pt. Both original configs were lucky scry cases.

Caveat, stated because it is the difference between a measurement and a theorem:
"exact on two monotone configs" is not "provably exact for all monotone queries".
The ordering only matters when the keep budget binds (`keepMax`, or draws left for
scry), and that nearest-completion-then-scarcity is optimal in that case is
measured, not argued. Settle that before making it the default -- detecting
"no upper bounds" and switching policy would otherwise be an easy exact speedup on
the common case.

**Finding 2:** with an upper bound it is a genuine trade -- the corner falls from
16552ms to 1279ms (13x) for -3.2pt. A fixed policy cannot see that keeping a card
now may force a busting draw later, which is exactly what the max is for. Useful as
a fast preview, not as a shipped number.

Both directions are pinned in `heuristicKeep.test.ts`, including that the heuristic
never EXCEEDS the optimum -- any fixed policy is a lower bound, so a positive
deviation would indicate a bug rather than a better policy.

### The keep heuristic is NOT a free speedup -- scope measured properly (2026-07-30)

Asked to turn the previous entry's "free speedup" into a default. Verified first,
across 8 configurations x 4 effect shapes instead of the original 2:

| shape | result on 8 monotone configs |
|---|---|
| draw | exact everywhere |
| impulse | exact everywhere |
| ponder | exact everywhere |
| **scry** | **wrong on 3 of 8, worst 1.03pt** |

So the earlier claim was an artifact of two lucky scry configs. **No default was
flipped.**

The pattern identifies the boundary: every failure has `keptCostsDraw: true`. When
a keep costs a draw there is a real trade over WHICH card to keep and a fixed rule
can choose wrong; when keeps are free the choice is unambiguous. And the regime
where the heuristic is dependable -- free keeps -- is exactly where the DP already
takes a single forced branch, so there is no max to skip and nothing to win.

Pinned in `heuristicKeepScope.test.ts` as a NEGATIVE result: the test asserts the
deviation EXISTS, so if a future change makes the heuristic exact the test fails and
the default can be revisited deliberately. It also asserts the heuristic never
exceeds the optimum, since any fixed policy is a lower bound.

Worth noting how close this came to shipping: two configs, a plausible mechanism
("keeping a needed card cannot be wrong"), and a 13x speedup all pointed the same
way. The mechanism was even correct -- for free keeps. It was the extension to scry
that was wrong, and only a wider sweep showed it.

### MQ was recomputing the same hypergeometric constantly: 3-7x for free (2026-07-30)

Observation: MQ evaluates the same formula many times, so precomputing or reusing
should help. The simplest form of that turned out to be sitting in plain sight --
`modifiedQuery.ts` (impulse) has always memoised its curve lookups and
`modifiedQueryScry.ts` never did, calling `evaluate()` raw inside the window walk.

Different window compositions frequently reduce to the SAME
`(pool, remaining counts, secured, index)` call, so the memo is pure waste
elimination:

| case (deck 60, look 3, 8 copies) | before | after | speedup |
|---|---|---|---|
| monotone, 12 draws | 2167ms | **772ms** | 2.8x |
| brick, 15 draws | 2437ms | **503ms** | 4.8x |
| OR + brick, 15 draws | 4386ms | **746ms** | 5.9x |
| monotone, 20 draws | 4552ms | **668ms** | 6.8x |

Values identical to seven decimals, so nothing about the model changed.

MQ now answers the corner in 746ms against the exact DP's ~16000ms, which is a 21x
margin -- the widest of the session, and it comes from removing duplicate work
rather than from any approximation.

**On the wider idea (precomputed differentials / finite-difference recurrences):**
worth knowing the boundary. The exact recurrences exist -- a hypergeometric curve
satisfies one in each parameter -- so a lattice could in principle be stepped rather
than recomputed. But the calls in MQ differ in POOL COMPOSITION and SHIFTED BOUNDS,
not draws alone, so a draws-only transformation cannot map between them; and the
DP's cost is state COUNT rather than per-state work, so it would gain little there.
Memoisation captures the same "do not recompute what you already know" insight
without needing the lattice. The remaining honest target for that idea is
`evaluate` computing a whole curve `0..N` when callers want one index -- worth
roughly N/n, and more useful to `frontier.ts` than to the selection engines.

### Why the draw budget only bites with bounds, and where a hypergeometric recurrence would pay (2026-07-30)

**Why slow draw consumption is nearly free in one place and dominant in another.**
Cost is roughly (levels before the horizon) x (states per level). Slow draw
consumption inflates the first factor, but only matters if branches actually reach
the horizon:

| case | draws burned per trigger | absorbs? | time |
|---|---|---|---|
| monotone scry | 0-1 (slow) | YES -- hits the threshold, returns 1, prunes | 135ms |
| ponder + bound | ~4 (whole window) | no | 64ms |
| scry + bound | 0-1 (slow) | no (satisfied then bust is possible) | 667ms |
| scry + bound + OR | 0-1 (slow) | no, plus clause state | 15807ms |

Monotone scry crawls but absorbs, so the long horizon is never walked. Ponder
cannot absorb but burns a whole window per trigger, so it reaches the horizon in a
few steps. Bounded scry gets neither. That is the interaction, and it supersedes two
earlier explanations in this file that blamed bottoming or pool fan-out.

**Where a hypergeometric recurrence would actually pay.** The proposal was to
transform the query's variables rather than the draw count. The identity is exact,
not a linearisation: `P(X >= k-1) = P(X >= k) + P(X = k-1)`, and likewise for upper
bounds -- shifting a threshold by one costs one pmf term instead of a fresh curve.

Instrumented MQ on the corner to see whether it pays after memoisation:

    58747 curve calls, 6461 misses, 4621 distinct (pool, sizes) combinations

So memoisation already absorbs 89% of calls, and the misses average only ~1.4
distinct thresholds per pool state. A threshold recurrence could therefore replace
at most 6461 - 4621 = 1840 curve builds: about 28% of remaining misses, perhaps 20%
overall. Real but not transformative.

The dominant remaining cost is the 4621 genuinely distinct POOL COMPOSITIONS, which
no threshold shift relates. Attacking those needs recurrences in the population
parameters (N and K -- removing one card of a group from the pool). Those identities
exist as well, but they are materially harder and imply maintaining a lattice keyed
on pool composition. Anyone picking this up should profile first: the split between
threshold-varying and pool-varying calls is what decides whether it is worth it, and
it took one instrumented run to find.

### The pool-composition axis is an artifact of the SPLIT form, not of MQ (2026-07-30, scoped)

Observation that reframes the previous entry: MQ's technique is bumped bounds plus a
draw count, and nothing else. So the 4621 distinct `(pool, sizes)` combinations
dominating its cost should not exist -- and they do not, in the original
formulation.

Two algebraically equivalent ways to evaluate the identity:

- **prefix form** (as originally proposed): score the SEEN population with bounds
  raised by what was ditched -- `evaluate(pool, counts, lo + ditched)[prefixLength]`.
  Pool and counts are FIXED; only the bounds and the index vary.
- **split form** (as implemented): score the remaining FRESH draws with bounds
  lowered by what was kept --
  `evaluate(pool - windowCards, counts - windowComp, lo - kept)[sched - spent]`.
  The window must leave the pool or its cards could be drawn twice.

The third axis is entirely the split form's. And since `evaluate` returns a whole
CURVE, the prefix form's calls would be reusable across every draw count, collapsing
the cache key to just the bound vector -- 4621 distinct calls could plausibly become
dozens.

This also corrects the record on an earlier exchange: when the split form's pool
reduction was questioned, the answer given was that the split form requires it, which
is true but incomplete. The prefix form avoids the axis altogether, and that axis
turned out to dominate the cost.

**The hazard, which has already bitten once:** the prefix form must condition
consistently. Enumerating the window's contents to learn `ditched`, then evaluating
over the full pool at the prefix length, double-counts those cards -- their
composition is fixed by the enumeration and re-randomised by the evaluation. That is
exactly what made the earlier one-shot joint lose 5-8% of its mass. A correct version
enumerates the ditch vector WITHOUT conditioning the remainder of the prefix.

Immediate tell if attempted: total mass. If the weights do not sum to 1.000000 the
conditioning is wrong, and one run reveals it -- far cheaper than discovering it from
a wrong answer, which is how the first attempt went.

### Prefix-form MQ attempted: mass 1.18, and the reason is structural (2026-07-30)

Built it as specified -- enumerate (triggers, copies-in-windows, total keeps) so the
prefix length is fixed, draw the prefix composition from the FIXED pool, split each
group positionally between fresh draws and window slots, derive keeps from the split
and partition on K. No `evaluate` calls at all.

Two runs, both caught by the mass check before any accuracy claim:

1. **mass 19-86** -- positional split miscounted: `comb(freshLeft, v)` (choosing
   POSITIONS) where it needed `comb(x_g, v)` (choosing which of that group's CARDS
   land in fresh slots). Fixed.
2. **mass 1.18-1.22** -- structural, and the reason the whole approach is not
   well-posed as specified.

**The structural problem:** `L = (n - K) + t*S` depends on `K`, which is an OUTCOME.
So summing probabilities computed over different-length prefixes is not a partition
-- "prefix of length 14 has composition X" and "prefix of length 15 has composition
Y" are overlapping statements about card sets, not disjoint events. Filtering on K
partitions the KEEPS but not the sample space, because each K carries its own prefix
length. Same obstruction that cost the one-shot joint 5-8% of its mass, arriving from
the other side: under-counting there, over-counting here.

**Why `cheapTail` is exact and this is not:** with `K = 0` the prefix length is fixed
by the slot structure alone, so no circularity arises and the events genuinely are
disjoint. The tail is not a lucky special case -- it is the only case where the prefix
form is well-posed without further work.

**What a correct general version needs:** configuration probabilities counted as
FRACTIONS OF ORDERINGS rather than as prefix-composition events. That is precisely
what the per-trigger recursion does by construction, since stepping never requires a
prefix length up front. So the prefix form's appeal -- a fixed pool, no evaluate calls
-- comes at the cost of needing the very sequencing it was meant to avoid.

Not a dead end necessarily: if the ordering-count can be written in closed form for
each (t, q, K) configuration, the fixed pool and the absent evaluate calls would still
make it cheap. But it is a counting problem, not the reformulation it looked like.

### Where MQ breaks, located by trigger count (2026-07-30)

Walked the algorithm step by step and tested which step is responsible.

`scryModifiedQueryPass`, with each step marked:

| # | step | status |
|---|---|---|
| 1 | `slotDistribution(deck, copies, look, draws - precedingKeeps)` | APPROX -- slot DP assumes free windows; `keeps*(t-1)/(2t)` is a scalar mean |
| 2 | `triggers = (seen - slotDraws)/look` | exact unless windows truncate (guarded) |
| 3 | `scheduled = draws - triggers` | exact |
| 4 | `windowNonCopy = triggers*look - copiesInWindows` | APPROX -- pools all t windows into one aggregate |
| 5 | enumerate the aggregate window composition | APPROX -- real windows are separate samples, from different pool states, at different times |
| 6 | `kept = min(w_g, maxLo_g)` | APPROX -- hand-agnostic |
| 7 | `collectable = min(scheduled, draws - firstTriggerPos)` | APPROX -- earliest trigger's position applied to ALL keeps |
| 8 | cap keeps at collectable | follows from 7 |
| 9 | `evaluate(pool - window, counts - w, lo - kept)[scheduled - spent]` | exact GIVEN the partition, which assumes every window precedes every fresh draw |

Error against the exact DP as copies rise (deck 60, A=10, need 2, look 3, 12 draws):

| copies | E[triggers] | error |
|---|---|---|
| 1 | 0.20 | **0.0000pt** |
| 2 | 0.40 | 0.0844 |
| 3 | 0.60 | 0.2224 |
| 4 | 0.80 | 0.3902 |
| 6 | 1.20 | 0.7219 |
| 8 | 1.60 | 0.9782 |
| 12 | 2.40 | 1.2470 |

**Zero at one copy, then growing super-linearly at first.** That is the signature of an
error requiring TWO triggers to exist, and it identifies the doom point precisely:
the SECOND AND LATER triggers. Their windows are drawn from a pool earlier windows
already depleted, at a time earlier keeps already shifted, and MQ collapses all of
that into one aggregate sample plus two scalar corrections.

Every approximation in steps 4-7 needs `t >= 2` to bite: pooling misrepresents nothing
with one window, "first trigger's position" IS the only position at t=1, and
`precedingKeeps` is identically zero at t=1. Which is why one copy is exact to
floating point.

Step 6 is NOT implicated: greedy keep is optimal for a single monotone clause, so it
contributes nothing to this curve. That is also why the per-trigger recursion -- which
fixes steps 1/4/5/7 by sequencing while KEEPING the greedy rule -- is exact here.

The flattening at the top (x1.27 from 8 to 12 copies) is saturation: as P approaches
0.87 there is less room to be wrong, the same compression that made the 20-draw row
look accurate.

### The trigger-budget term is only ~20% of MQ's error (2026-07-30)

Two questions chased: are ditched cantrips being double-counted as triggers, and is
`n` adjusted for keeps?

**Ditched cantrips: already handled, no bug.** MQ separates them --
`triggers = (seen - slotDraws)/examined` counts copies in SCHEDULED slots, and
`copiesInWindows = outcome.copies - triggers` are merely seen and dead. The slot DP
enforces it too: its `credits > 0` branch consumes a copy without granting credits.
Subtracting them again would double-subtract.

**The real conflation is one level up: draws versus FRESH REVEALS.** A kept card is
collected by a draw that reveals nothing new, so with `K` keeps there are only
`n - K` chances to find a cantrip while the slot layer hands out `n`. Measured skew:
E[triggers] 1.5244 true (200k simulations) against 1.5707 assumed -- about 3% high,
concentrated in the tail.

**But the budget is not where the error lives.** MQ adjusts the two budgets
differently and deliberately: fully for acquisition (`scheduled - spent`), partially
for trigger-finding (`K*(t-1)/(2t)`, since keeps after a trigger cannot stop you
reaching it). Sweeping that coefficient:

| coefficient | A>=2 c8 n12 | A>=2 c12 n12 | A>=3 c8 n15 |
|---|---|---|---|
| 0.00 (none) | 1.067pt | 1.445pt | 1.734pt |
| 0.50 (current) | 0.978pt | 1.247pt | 1.541pt |
| 1.00 (every preceding keep) | 0.894pt | 1.063pt | 1.360pt |

Monotone in the coefficient but plateauing far above zero. The entire term is worth
0.17-0.38pt of a 1.07-1.73pt error -- **about a fifth**. Consistent with a 3% trigger
skew, which was never going to produce a full point.

**So ~80% of the error is steps 4-5: pooling all `t` windows into one aggregate
composition drawn from one pool state.** Window 2 is really drawn from a pool window 1
already depleted, at a time earlier keeps already shifted. No scalar budget adjustment
can express that, which is why every correction attempted on step 1 -- mean deduction,
distribution-level fixed point, coefficient sweep -- has moved the number by tenths
while the error stayed above a point.

### Isolation attempt: step 5 turns out not to be an error at all (2026-07-30)

Tried to separate step 4 (pooling the window SLOTS) from step 5 (sampling every
window from one pool state) by drawing the `t` windows sequentially from a depleting
pool. Two runs, both confounded -- the first dropped the position cap while changing
the sampling, the second kept the cap but still came out WORSE than stock (2.702pt
against 0.978pt) with mass 1.000000.

The useful part is what the failure exposed: **drawing `t*S` cards as one sample is
distributionally IDENTICAL to drawing `S` at a time from the remainder.** That is
just the chain rule for sampling without replacement. So "window 2 is really drawn
from a pool window 1 already depleted" -- an explanation used repeatedly in the
entries above -- is handled CORRECTLY by the aggregate sample. Step 5 is not an
approximation.

Relocated:

| step | verdict |
|---|---|
| 1 -- trigger budget | real but small, ~20% by the coefficient sweep |
| 5 -- pooled sampling | **not an error**, distributionally identical |
| 4 -- pooled keep BUDGET | suspect: one budget spans all windows, so a keep belonging to window 2 can be paid by a draw that came before it |
| 7 -- single position cap | suspect: the earliest trigger's position is applied to every keep |

The sequential variant coming out worse is not evidence about the model -- it kept
the pooled budget and the single cap while changing only something that was already
exact, so the delta measures an implementation error of mine, not a property of MQ.

Next isolation should hold the sampling fixed (it is correct) and vary only the KEEP
BUDGET: give each window its own budget of draws-remaining-at-that-trigger instead of
one shared pool of keeps. That is a single-variable test of step 4, and it needs
trigger positions per window rather than just the first.

### The position cap IS the lever: bracketed between first and last trigger (2026-07-30)

Framing that produced this: a keep can only be paid by a draw in a "timeline" where
that draw comes after the trigger, so the fix is a weighted average over which
timeline you are in -- not a single cap.

MQ currently caps every keep by the EARLIEST trigger's position, the most generous
timeline available. Swapping in the LATEST trigger's position (most restrictive) is a
single-variable bracket test:

| case | first trigger | exact | last trigger |
|---|---|---|---|
| A>=2, 8 copies, 12 draws | +0.978pt | 0 | **-2.763pt** |
| A>=2, 4 copies, 12 draws | +0.390pt | 0 | -0.642pt |
| A>=3, 8 copies, 15 draws | +1.541pt | 0 | -4.186pt |

**The sign flips, so the position cap is the dominant term** -- the bracket spans
3.7pt on the first row and the whole error lives inside it. Together with the
coefficient sweep (trigger budget worth ~20%) and the sampling result (step 5 exact),
the error is now fully accounted for.

**The asymmetry is informative:** the exact answer sits about 26% of the way from
first to last, i.e. much closer to the generous end. That fits keeps concentrating in
EARLY windows -- the first trigger usually fires with most draws still available, so
most keeps really are collectable, and only later windows get squeezed.

**Implementable fix:** weight each window's keeps by ITS OWN position marginal,
`C(p-1, i-1) * C(draws-p, t-i) / C(draws, t)` for the i-th of t, instead of putting
every keep on the first. Closed-form marginals, so it costs an enumeration over `i`
rather than over joint positions, and it should land near the observed 26%
automatically because early windows carry more keep mass.

Not implemented: it is a real change to the keep accounting, and three consecutive
attempts at changes of that shape needed reverting. The bracket is the durable
artifact -- it proves the lever and bounds the answer.

### Per-window position marginals landed: worst case 2.138 -> 1.455pt (2026-07-30)

Implemented the fix the bracket pointed at: a keep from the i-th trigger can only be
paid by draws after THAT trigger, so charge it to the i-th order statistic rather
than putting every keep on the first. Marginals are closed-form
(`C(p-1,i-1)*C(draws-p,t-i)/C(draws,t)`), averaged over i.

| case | before | after |
|---|---|---|
| no copies / nothing kept / one copy | exact | **exact** (invariants held) |
| fewest draws | +1.466 | **-0.113** |
| many copies | +0.978 | **-0.453** |
| smallest look | +0.464 | **-0.086** (in bar) |
| largest look | +0.902 | -0.978 (slightly worse) |
| most draws | +0.139 | -0.234 (slightly worse) |
| one clause + brick | +1.527 | **+1.022** |
| OR + brick | +2.138 | **+1.455** |

Worst case improved 32%, the biggest single gain being 13x on `fewest draws`. Mass
stays 1.000000 throughout, and the one-copy invariant holds by construction --
averaging over windows is a no-op when there is only one.

**Two rows crossed zero and ended slightly further out.** That is the predicted
overshoot: uniform averaging assumes keeps spread evenly across windows, but they
concentrate in EARLY ones, since a card is kept while the need is still unmet. The
bracket said the truth sits ~26% of the way from generous to restrictive; uniform
averaging puts it near 50%.

**Next refinement, now well-specified:** weight each window by its KEEP MASS rather
than uniformly. Early windows hold more keeps, so they should carry more of the
weight, which should move the estimate from ~50% back toward the observed ~26%.

Cost: the corner went 746ms to 2719ms, since the position loop now runs once per
window index. Still 6x faster than the exact DP's 16251ms, so the trade is worth it
at current accuracy -- but it is a trade, not a free win.

### Per-window capacity attempt: reverted, and the invariant caught it (2026-07-30)

Implemented the fix the bracket implied -- spread pooled keeps across the `t` windows
and cap each share by that window's own remaining draws, using the order-statistic
mean `E[p_i] = i(n+1)/(t+1)`.

**Reverted. It broke the one-copy invariant immediately:** 0.000pt -> +0.254pt, and
every other row got worse (c4: 0.390 -> 0.901, c8: 0.978 -> 1.355).

The mistake is worth naming because it is the third instance of the same class this
session: I replaced the position ENUMERATION with a position MEAN. The existing code
enumerates `p` with its marginal weights, which is exact at t=1; substituting
`E[p] = 6.5` is a Jensen collapse, the same error as the mean-field fixed point
earlier. A nonlinear function of a distribution is not the function of its mean.

What a correct version must preserve: the position DISTRIBUTION per window, not its
mean. That means weighting each window's keeps by its own marginal
`C(p-1,i-1)*C(draws-p,t-i)/C(draws,t)` inside an enumeration over both `i` and `p`,
which is more expensive than the single loop it replaces -- and that cost is probably
why the shortcut was tempting.

The one-copy invariant did its job: it is the cheapest possible detector for exactly
this failure, since at t=1 the first, last and mean positions all differ while the
true answer is known. Any future attempt should be run against it FIRST, before any
accuracy sweep.

### The sweet point is derivable, not fittable: lambda = keep-mass distribution (2026-07-30)

Proposal: the interpolation weight between the bracket's endpoints is probably a
FUNCTION of the parameters rather than a constant. Answered analytically -- no
instrumentation, which matters given three broken probes in a row.

For `t` triggers uniformly placed among `n` draws, `E[p_i] = i(n+1)/(t+1)`. So:

- earliest cap: `n - (n+1)/(t+1)`
- latest cap: `n - t(n+1)/(t+1)`
- keeps spread EVENLY across windows: `n - mean_i E[p_i]` = `n - (n+1)/2`

Interpolating the even-spread cap between the endpoints:

    lambda = [(n+1)/2 - (n+1)/(t+1)] / [(t-1)(n+1)/(t+1)]
           = [(t+1)/2 - 1] / (t-1)
           = 1/2

**Exactly one half, independent of n, t, deck size, look size -- everything.** So
under even spread the sweet point would be a universal constant.

**Measured lambda is ~0.26, not 0.5.** That gap is the result: keeps are FRONT-LOADED.
Mechanically obvious in hindsight -- the first window fires with nothing acquired, so
everything it sees is needed, while later windows often find nothing worth keeping
because the need is already met. More keep mass in early windows pulls the effective
cap toward the first trigger's generous budget.

So lambda is not free; it is determined by the keep-mass distribution:

    lambda = sum_i w_i * (i-1)/(t-1),   w_i = fraction of keeps in window i

Even spread recovers 1/2 by the algebra above. Front-loading gives less. The measured
0.26 implies roughly two thirds of keep mass in the first window at t ~ 2.

**Consequence for the fix: do not calibrate lambda -- compute `w_i`.** Window i's
expected keeps follow from how much need survives windows 1..i-1, so weighting the
caps by `w_i` gives the correct blend with NO fitted constant. The governing terms are
need, copies and look, since those determine how fast need is consumed.

This also explains the failed per-window attempt directly above: it assumed
`w_i = 1/t`, i.e. lambda = 1/2, when the truth is ~0.26. It over-restricted, which is
exactly the direction the numbers moved.

### w_i derived in closed form, and it predicts the measured lambda (2026-07-30)

The constraint that makes it tractable: **total keeps never exceed `need`**, because
nothing is kept once the requirement is met. So the keep mass spreads over at most
`need` events, and

    w_i  proportional to  P(need unmet when window i fires) x P(window i holds a needed card)

Both factors are closed-form hypergeometrics: the second is
`1 - C(pool-A, S)/C(pool, S)`, the first a hypergeometric tail over the
`E[p_i] + (i-1)*S` cards seen before window i.

Implied lambda, with nothing fitted:

| config | t=2 | t=3 |
|---|---|---|
| base (need 2, look 3, deck 60) | **0.238** | 0.214 |
| need 3 | 0.323 | 0.303 |
| look 5 | 0.172 | 0.141 |
| deck 40 | 0.231 | 0.175 |

**Measured lambda on the base config is 0.2614** (from the bracket:
`(0 - 0.978)/(-2.763 - 0.978)`). Derived 0.214-0.238 across the t values that config
mixes -- within about 20% relative, from first principles.

The directions confirm the hypothesis that lambda is a function of the terms:
- **need 3 raises it to 0.32** -- more need keeps later windows productive, pushing
  mass rightward;
- **look 5 lowers it to 0.17** -- bigger windows let the first one satisfy everything,
  concentrating mass leftward;
- deck size barely moves it.

Pinned in `keepMass.test.ts`, which asserts front-loading (`lambda < 1/2`, `w_1 > w_2`)
and both directional relationships, so a future change that breaks the mechanism fails
rather than silently drifting.

Residual gap (0.238 derived against 0.2614 measured) is most likely the crude
`seenBefore`, which uses `E[p_i]` rather than the position distribution -- the same
mean-collapse that broke the per-window attempt two entries above. Using the marginal
there should tighten it and keeps the derivation honest.

### w_i wired into MQ: error roughly halved, all invariants intact (2026-07-30)

Wired the derived per-window keep mass into the keep cap. Each window is weighted by
its own `w_i` and uses its OWN position marginal (`orderStatistic(draws, t, i)`),
instead of putting every keep on the first trigger's most-generous budget.

**Safety property that made this attempt work where four earlier ones failed:** at
`t = 1`, `w = [1]` and `i = 1`, so the code reduces EXACTLY to the previous
behaviour. The one-copy invariant therefore cannot break by construction, rather than
by luck -- and it was checked FIRST, before any accuracy sweep, per the note added
after the last failure.

Invariants, all exact and mass 1.000000: one copy, nothing-ever-kept, zero copies.

| case (deck 60, A=10, look 3, 12 draws unless noted) | before | after |
|---|---|---|
| copies 2 | 0.084pt | **0.030pt** |
| copies 4 | 0.390pt | **0.160pt** |
| copies 8 | 0.978pt | **0.486pt** |
| copies 12 | 1.247pt | **0.775pt** |
| look 1 | -- | 0.176pt |
| look 5 | -- | 0.479pt |
| draws 6 | 1.466pt | **0.426pt** |
| draws 20 | 0.139pt | **0.106pt** |
| need 3 (15 draws) | 1.541pt | **0.641pt** |
| deck 40 | -- | 0.570pt |
| deck 99 | -- | 0.266pt |
| brick (15 draws) | 1.527pt | **1.418pt** |

Roughly halved everywhere, worst case down from ~2.1pt to 1.418pt, and `copies 2` is
essentially in bar at 0.030pt. Every existing test still passes, including the report
test that pins the worst-case configuration and the strict bound.

Note the brick row improved least (1.527 -> 1.418). That fits: with an upper bound the
error is not only about keep timing, so the remaining term there is different from the
one just fixed -- consistent with the earlier finding that bounded queries lose
absorption entirely.

Remaining error is still front-loaded in the same direction (always positive), so the
next candidates are the residual mean-collapse in `seenBefore` (it uses `E[p_i]`
rather than the position distribution, which the derivation entry already flags) and
the pooled keep budget itself, which still shares one `spent` across windows.

### A SECOND, distinct error: keeping pieces while avoiding bricks (2026-07-30)

Suspicion that the residual involved bricks and copy count together. Measured, deck 60,
A=10, brick=4, look 3, 15 draws:

| copies | monotone `A>=2` | brick `A>=2 & brick<=0` | brick-only `brick<=0` |
|---|---|---|---|
| 1 | -0.000pt | **+0.111pt** | -0.000pt |
| 2 | 0.030pt | 0.256pt | -0.000pt |
| 4 | 0.143pt | 0.627pt | -0.000pt |
| 8 | 0.328pt | 1.418pt | 0.000pt |
| 12 | 0.411pt | **2.209pt** | -0.000pt |

Three facts pin it down:

1. **The brick error is nonzero at ONE copy (+0.111pt)**, where monotone is exact. So
   this is NOT the multi-trigger mechanism fixed by `w_i` -- it exists with a single
   window.
2. **Brick-only is exact at every copy count.** So brick handling in isolation --
   bottoming, cap arithmetic, window accounting -- is all correct.
3. Brick error grows about 5x faster in copies than monotone (2.209 against 0.411 at
   12 copies), and monotone is flattening while brick keeps climbing.

So the bug is in the INTERACTION: keeping a piece while bottoming a brick, in the same
window. Present with one trigger, absent when either ingredient is removed alone.

Likely mechanism, to be confirmed before any fix (per CLAUDE.md #21b): when a window
holds both a needed piece and a brick, MQ keeps the piece and bottoms the brick, but
`spent` charges a draw for the keep while the query shift credits only the piece --
the brick's removal from the pool is applied globally rather than being tied to that
window. The two effects end up accounted on different timelines.

This also explains why `w_i` barely moved the brick row (1.527 -> 1.418): that fix
corrected keep TIMING, and this is a different term.

Cheapest confirmation: a query needing a piece with a brick cap where the brick count
is zero (no bricks in deck) must be exact, and a window-content sweep should show the
error concentrated in windows containing BOTH a piece and a brick.

### Same-window hypothesis REFUTED; the brick term's fingerprint (2026-07-30)

Tested the suspicion from the previous entry -- that the residual needed a piece and a
brick in the SAME window -- using the minimal reproducing case (one copy, one window).

**Refuted.** With `look = 1` a window holds a single card and cannot contain both, yet
the error persists at +0.038pt. The mechanism guessed in the previous entry is wrong,
and this is the second wrong mechanism guessed tonight (after the mean-position one).

The measured fingerprint, deck 60, A=10, 15 draws, one copy, `A>=2 & brick<=0`:

| varying look | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| error | 0.038pt | 0.076pt | 0.111pt | 0.140pt | 0.163pt |

| varying brick count | 0 | 1 | 2 | 4 | 8 |
|---|---|---|---|---|---|
| error | **EXACT** | 0.057pt | 0.090pt | 0.111pt | 0.079pt |

| varying need | 1 | 2 | 3 |
|---|---|---|---|
| error | **0.174pt** | 0.111pt | 0.042pt |

What the shape says:
- **zero bricks is exact**, so the error requires bricks in the DECK, not in the window;
- it **grows with look**, so it scales with window size;
- it **shrinks as need rises**, the OPPOSITE of the keep-timing error `w_i` fixed, which
  grew with need -- confirming these are separate terms;
- it **peaks at moderate brick counts** (rising to 4, falling by 8), the signature of a
  term carrying `P(brick) * P(no brick)`, maximal at middling exposure.

The `need=1` peak is the most suggestive: with need 1 a single keep ends all keeping, so
keeps happen early and exactly once. Combined with the look scaling, that points at
BRICK EXPOSURE being mis-accounted around the window that produces the keep, rather
than at the keep itself.

Next step is deliberately not another hypothesis: find the term in the code whose
behaviour matches `look * P(brick)P(no brick) / need`, rather than guessing a mechanism
and wiring it. Two guesses tonight were both wrong, and both cost a revert.

### Extreme brick test amplifies the error 500x: 0.1pt becomes 55% relative (2026-07-30)

Suggested test: push bricks to the maximum that still allows a nonzero win rate --
`bricks = deck - draws`, so the non-brick cards number exactly `draws` and only one set
of orderings can win. With no cantrips the answer is analytically `1/C(deck, draws)`.

| config (deck 20, 6 draws, A=2) | analytic | exact DP | MQ | relative error |
|---|---|---|---|---|
| no cantrips (14 bricks) | 2.5800e-5 | 2.5800e-5 | 2.5800e-5 | **0.00%** |
| 1 cantrip | -- | 4.3860e-5 | 5.1600e-5 | **+17.65%** |
| 2 cantrips | -- | 6.1920e-5 | 9.6163e-5 | **+55.30%** |
| slack (12 bricks), 1 cantrip | -- | 9.6196e-4 | 1.0283e-3 | +6.90% |

Three findings:

1. **The analytic value confirms both engines' baseline.** DP and MQ both return
   `1/C(20,6)` exactly with no cantrips, so brick handling without an effect is correct.
2. **Cantrips HELP in this regime, contrary to the prediction made before measuring.**
   The DP rises 2.58e-5 -> 4.39e-5 -> 6.19e-5, because a window bottoms bricks off the
   top and lets the draws reach the non-bricks behind them. The cantrip acts as a brick
   filter. The prediction had been that bottoming would hurt by pushing non-bricks away.
3. **MQ over-credits that filtering and compounds per cantrip** (+17.65%, then +55.30%).
   Its one-cantrip answer is `5.1600e-5`, exactly twice the no-cantrip analytic value --
   a clean doubling that suggests a term counted once per cantrip rather than
   conditioned properly.

Value of this configuration: it turns a 0.1pt discrepancy in ordinary decks into 55% of
the signal, so any candidate fix is unmistakably right or wrong instead of lost in
noise. Pinned as `brickExtreme.test.ts`, asserting the analytic baseline, that cantrips
help, and that MQ currently over-credits.

### CONFIRMED: MQ compounds brick filtering per cantrip; the DP accumulates it (2026-07-30)

Swept copy count in the extreme regime (deck 20, 6 draws, A=2, 14 bricks, look 3), with
`baseline = 1/C(20,6) = 2.58e-5`:

| copies | exact DP (x base) | MQ (x base) | MQ/DP |
|---|---|---|---|
| 0 | 1.000 | 1.000 | 1.0000 |
| 1 | 1.700 | 2.000 | 1.1765 |
| 2 | 2.400 | 3.727 | 1.5530 |
| 3 | 3.100 | 6.727 | 2.1701 |
| 4 | 3.800 | 12.792 | 3.3663 |

**The DP is exactly LINEAR: 1.0, 1.7, 2.4, 3.1, 3.8 -- increments of precisely 0.7 per
cantrip.** Each cantrip contributes a fixed amount of brick filtering.

**MQ is MULTIPLICATIVE: ratios of 2.00, 1.86, 1.80, 1.90 -- about x1.9 per cantrip.**

So the bug is compounding where it should accumulate, which explains every earlier
observation at once: it grows with look (bigger per-cantrip factor), vanishes without
bricks (nothing to compound), shrinks as need rises (keeps consume the effect), and
reaches +55% at two copies and +237% at four.

**This contradicts an earlier entry in this file.** The claim that aggregate window
sampling is exact "by the chain rule" holds for ONE sample of size `t*S`; it does NOT
hold if the removal is applied per-cantrip in sequence. The next step is to check
whether `windowNonCopy = triggers*examined - copiesInWindows` is subtracted once from
the pool or effectively compounded across cantrips -- that is a code question with a
definite answer, not another hypothesis.

Diagnostic value of this configuration: the DP's perfectly linear signature gives a
reference shape, so a correct fix must reproduce increments of 0.7x base rather than
merely reducing the error.

### Audit: no literal compounding in the code, and why a linear counter-term is the wrong fix (2026-07-30)

Audited the pool accounting for a per-cantrip duplication. **There is none.**
`windowNonCopy = min(triggers*examined - copiesInWindows, pool)` is computed once per
slot outcome and subtracted once, and `remaining = counts - windowComposition` likewise.
No loop applies the removal per cantrip.

So the multiplicative behaviour is EMERGENT from the conditioning, not a duplicated
term that can be deleted. Mechanism as far as the structure shows: MQ conditions on the
window composition (for instance "all three window cards were bricks"), which makes the
remaining pool brick-poorer and raises `P(fresh draws are brick-free)`. Each further
cantrip adds another window's worth of that conditioning, and because they are all
applied to one pooled remainder the effects multiply. In the extreme regime, where
winning requires every drawn card to be a non-brick, that conditioning is worth a great
deal -- which is why the compounding is most visible there.

**On adding a linear counter-term: advised against, for three specific reasons.**

1. **Exact cases would be at risk.** One-copy monotone, nothing-ever-kept, zero copies
   and the no-cantrip analytic baseline are all currently EXACT. A term fitted to the
   brick regime must be gated so tightly that it touches none of them, and every gate
   is a place to be wrong.
2. **The 0.7x increment is not a universal.** It is a property of this
   deck/draws/look/brick combination, so the constant would need refitting per family --
   which is precisely how the two earlier corrections failed
   (`1.3*copies*P(1-P)` and `2S*keeps/n`, both overshooting off their fitted family).
3. **The sign is not stable.** MQ's error is positive here, but the brick-regime error
   flipped sign for non-monotone queries earlier in the session, so a single-signed
   correction would be wrong somewhere else.

**Practical position instead:** MQ is usable where it has been measured -- monotone
queries at roughly 0.4-0.8pt after the `w_i` fix -- and should not be trusted in
brick-heavy decks. That costs little, because the DP is not merely exact there but also
FAST: bounded queries with bottoming ran 667ms, nothing like the 16s OR corner. The
expensive corner and the inaccurate corner are not the same place, so routing can
prefer the DP for bounds and MQ for monotone.

### Corner decomposition: the brick bug IS the corner (2026-07-30)

Argument made: bounded+OR is the corner, bounded almost always means bricks, and it is
by far the DP's worst case -- so the brick bug is the priority. Measured, deck 60,
look 3, 8 copies, 15 draws:

| case | MQ error | DP time | MQ time |
|---|---|---|---|
| OR, no brick | **0.038pt** | 1347ms | 804ms |
| 1 clause + brick | **1.418pt** | 531ms | 241ms |
| OR + brick (corner) | **1.957pt** | **14787ms** | 1989ms |

**MQ's OR handling is already inside the bar at 0.038pt.** So the corner's 1.957pt is
almost entirely the brick term (1.418pt from bricks alone plus interaction), and fixing
it should bring the corner down to roughly OR-alone accuracy.

**The DP's cost is the INTERACTION, not either ingredient.** OR alone 1347ms, brick
alone 531ms, both 14787ms -- a 10-28x blowup from combining them, consistent with the
absorption analysis: with a brick in every clause, no clause is unbreakable, so nothing
absorbs and every branch runs to the horizon.

Conclusion, and the priority for the next session: the brick compounding bug is the ONLY
thing between MQ and being a trustworthy ~7x-faster answer in the single regime where the
DP is unusable. Everything else in MQ is either exact or within bar. That makes it worth
more than the remaining items (multivariate cheap tail, greedy-to-max in the recursion,
multi-type effects), all of which improve places that already have a working option.

Acceptance criteria for a fix, from the extreme test: MQ must reproduce the DP's LINEAR
per-cantrip increment (0.7x base in that configuration) rather than merely producing a
smaller number, and must leave the four exact cases untouched -- one-copy monotone,
nothing-ever-kept, zero copies, and the no-cantrip analytic baseline.

### Shared-bound hoisting: the insight is right, the implementation is not a win (2026-07-30)

Observation that started it: `(A>=2 | B>=2) & brick<=0` is the same query as
`(A>=2 & brick<=0) | (B>=2 & brick<=0)` but framed with the bound OUTSIDE the OR, and
the DP's cost comes precisely from the bound being duplicated across clauses (no clause
unbreakable, so nothing absorbs).

Correct follow-up, and it needed no query rewriting: when the same single bound is shared
by EVERY clause, satisfying any clause's lower bounds leaves exactly one open question --
will a bounded card still reach hand -- which `cheapTail` answers exactly. So the early
exit can be restored where a duplicated bound destroyed it.

First attempt put this in `exactSelectionCurveDnf` and was abandoned before measuring:
`cheapTail` imports `slotDistribution` from selection.ts, so that direction creates a
CIRCULAR IMPORT in the reference implementation. Not worth the risk; moved to the
recursion, which already imports `cheapTail`.

Measured on the corner (deck 60, A=10/B=6/brick=4, look 3, 8 copies, 15 draws):

| | recursion before | with shared-bound tail | exact DP |
|---|---|---|---|
| time | 91s | **18.0s** | 23.7s |
| error | -0.188pt | **-0.576pt** | exact |
| states | 185724 | **10418** | -- |

**The structural claim is confirmed: 18x fewer states.** The early exit really is what the
duplicated bound was costing. But the speedup is only 5x, not 18x, so the `cheapTail`
calls themselves are now the bottleneck -- each is 4-22ms and there are enough distinct
tail states to absorb the savings. And the error TRIPLED, from -0.188 to -0.576pt.

Reverted: 18s is still unusable, and a strictly-worse-accuracy path is not worth keeping
even in a research module.

What this leaves for a future attempt, in order of value:
1. **Make `cheapTail` cheaper.** It is already the degenerate case, but at 4-22ms per
   distinct tail state it cannot be called thousands of times. Its own slot distribution
   is cached; the per-call loop over slot outcomes is not.
2. Understand the accuracy regression before reusing the handoff -- the tail is exact for
   pure upper bounds, so tripling the error suggests the handoff fires in states where the
   remaining process is not purely a bound question.

### Why the shared-bound handoff was LESS exact: the precondition, not the query (2026-07-30)

Observation: if two logically identical query framings give different accuracy, something
deeper is wrong. Correct, and the cause is the handoff's precondition rather than the
query.

`cheapTail` is exact **only when no keeps can occur** -- that is its defining
simplification, and what removes the window enumeration. The handoff was gated on ANY
clause's lower bounds being met. For an OR that is the wrong condition: if clause 1 is
satisfied while clause 2 still wants cards, the greedy keep rule keeps them anyway, so
keeps DO occur and the tail's premise is violated.

Those keeps are not neutral either. **A keep costs a draw, and a draw not taken is a brick
not risked.** So keeping toward an unsatisfied clause reduces brick exposure -- a real
benefit the tail discards by assuming zero keeps. That makes the handoff pessimistic,
which matches the observed sign and magnitude (-0.576pt against the full recursion's
-0.188pt).

It also explains why the single-clause handoff was correct all along: with `C === 1`,
"any clause satisfied" and "all clauses satisfied" are the same statement, so the
precondition held by accident of arity rather than by design.

**Correct gate: EVERY live clause's lower bounds met** (equivalently, no live clause wants
anything). Identical to the current behaviour for one clause, strictly narrower for OR --
so it would fire less often and recover less of the 18x state reduction, but would not
corrupt the answer.

Second-order point worth carrying: with `optionalResolve`, once satisfied you would
DECLINE further casts (the window achieves nothing) and keeping is worthwhile only as
draw-burning. So the endgame of a bounded query has genuinely different optimal play from
the midgame. The tail models that correctly for the all-satisfied case and not at all for
the partially-satisfied one, which is exactly the gap that produced the regression.

## CONSOLIDATED PUNCH LIST (end of 2026-07-30 session)

PLAN.md has grown long and several entries retract earlier ones. This is the current
state; where an entry above conflicts with this list, this list is later.

### The corner -- bounded + OR -- the only regime with no working option

DP is exact at 15-24s; MQ is 746ms-2s at +1.96pt. Two independent routes.

**Route A: make the DP fast there. Cause understood, fix specified.**
A duplicated bound means no clause is unbreakable, so nothing absorbs and every branch
walks to the horizon. Restoring absorption cut states 185724 -> 10418 (18x).

| culprit | remedy | confidence |
|---|---|---|
| handoff gate fires on ANY clause satisfied, but `cheapTail` requires that NO keeps can occur | gate on EVERY live clause satisfied | high -- derived, explains the -0.576pt regression |
| `cheapTail` costs 4-22ms per call and is called thousands of times | cache the per-outcome sum keyed on (pool, bounded count, cap, copies, look, draws); its slot distribution is cached, the loop over outcomes is not | high -- mundane perf work |
| placing the handoff in `selection.ts` creates a circular import (`cheapTail` imports `slotDistribution`) | keep it in the recursion, or split `slotDistribution` into its own module | high |

**Route B: make MQ accurate there. Blocked on a missing derivation.**

| culprit | status |
|---|---|
| brick filtering compounds per cantrip -- DP linear (0.7x base each), MQ multiplicative (~x1.9) | fingerprinted and audited: NOT a duplicated line, emergent from conditioning window composition against one pooled remainder. No mechanism yet, so no remedy yet |

### MQ residuals on monotone queries (0.3-0.8pt after `w_i`)

| culprit | remedy | confidence |
|---|---|---|
| `seenBefore` inside `keepMass` uses `E[p_i]` instead of the position distribution | use the marginal -- this is the mean-collapse that broke two earlier attempts | high; likely explains the derivation's residual ~20% |
| keep budget still pooled across windows (one `spent` shared) | per-window budgets, requires per-window positions | medium |

### Lower value (each has a working alternative today)

- greedy keep in the recursion, -0.03 to -0.19pt -> max over commit vectors, costs time
- multivariate `cheapTail` for several bounded groups
- multi-type effects for scry/impulse -- a FEATURE gap, not an error
- ponder in the recursion -- do NOT; the DP answers it in 64ms

### Acceptance criteria for any fix

1. The four exact cases stay exact: one-copy monotone, nothing-ever-kept, zero copies,
   no-cantrip analytic baseline (`1/C(deck, draws)`).
2. Mass stays 1.000000 wherever an enumeration reports it.
3. A brick fix must reproduce the DP's LINEAR 0.7x-per-cantrip increment in
   `brickExtreme.test.ts`, not merely a smaller error.
4. Run the invariants BEFORE any accuracy sweep. Three of this session's four failed
   attempts would have been caught in one run by doing so.

### Route A attempted: the speedup came from the incorrectness (2026-07-30)

Executed the punch list's Route A in order -- make `cheapTail` cheaper, then correct the
handoff gate, then measure.

**Step 1, `cheapTail` cost.** First hypothesis (memoise `comb`, which sits in the
innermost loop) was WRONG: 314ms -> 319ms over 200 calls, accumulator identical. The
measurement found the real cause in the test's own shape -- `slotDistribution` is cached
on `maxDraws`, so asking for exactly `draws` rebuilds the entire slot DP for every
distinct draw count, even though it already returns all counts up to the maximum.
Requesting a bucketed ceiling and indexing collapses that dimension: **314ms -> 224ms
(1.4x), bit-identical results.** Kept. The remaining cost is one slot-DP build per
distinct POOL, which is intrinsic.

**Step 2, the corrected gate.** Results on the corner:

| gate | states | time | error |
|---|---|---|---|
| no handoff | 185724 | 91s | -0.188pt |
| ANY clause satisfied (wrong) | 10418 | **18s** | -0.576pt |
| EVERY clause satisfied (correct) | 93922 | 73s | **-0.188pt** |

**The speedup came from the incorrectness.** The correct gate restores exactness but
fires only when every clause is satisfied, which is rare in an OR, so it recovers 2x of
the state reduction and 1.25x of the time. The wrong gate fired constantly precisely
because it ignored the still-hungry clause.

So Route A is blocked by the same precondition that broke the first handoff: `cheapTail`
is exact only with no keeps, and an OR query usually has a clause still wanting cards.
Getting the 18x honestly requires a tail that PERMITS keeps -- which is not `cheapTail`
and not a small change; it is the general problem again, restricted to the endgame.

Both changes kept (each exact, each strictly better than before), but the corner is not
solved: recursion 73s, DP 16s. The DP remains the only correct option there, and MQ the
only fast one at +1.96pt.

Revised view of the punch list: Route A's remaining blocker is no longer performance
plumbing, it is the same modelling gap as Route B. That materially weakens the earlier
claim that Route A was "engineering, not research".

### The endgame keep rule is SAFETY, not acquisition -- the missing mechanism (2026-07-30)

The bounded-OR corner is not rare in real decks (two combos ruined by the same bad card
is an ordinary build), so it is worth continuing. Thinking about WHY the corrected gate
underestimates gives the next model.

**Observation: with a shared bound, once any clause is satisfied the other clause stops
mattering.** If `A>=2` holds and no brick is in hand, the query is already won -- `B` is
irrelevant. So the question "why would a player keep toward clause 2" has an answer that
is not about clause 2 at all:

**Keeping is SAFETY, not acquisition.** A kept card is a KNOWN card. Keeping a known
non-brick makes the next draw guaranteed safe instead of a gamble against the pool. In
the endgame of a bounded query, scry's function is not finding pieces -- it is converting
unknown draws into known-safe ones.

That reframes the tail:
- `cheapTail` assumes ZERO keeps, so every remaining draw risks a brick -> underestimates;
- optimal play keeps every safe card it sees, converting up to `min(S, d)` risky draws
  into safe ones per window -> substantially higher.

Direction confirms it: the recursion with the corrected gate lands at **-0.188pt**, i.e.
pessimistic, exactly as this predicts.

**So the missing object is not "a tail that permits keeps toward the unsatisfied clause".
It is a tail with a DIFFERENT KEEP RULE: keep every non-brick seen, bottom every brick,
purely to burn risky draws.** That should stay closed-form-ish, because it never needs to
know WHICH pieces are held -- only how many draws were converted to safe ones.

This also explains a measurement noted earlier and not pursued: ponder scores HIGHER than
scry on brick queries (0.35467 against 0.30347) despite being unable to bottom anything.
Ponder cannot be forced to draw blind either. **The brick regime rewards INFORMATION
rather than selection**, and every model built so far -- MQ's keep rule, the recursion's
greedy, `cheapTail`'s no-keeps -- optimises for selection. That is a single shared blind
spot rather than three separate bugs, and it is the most promising thing found today for
the corner.

Next concrete step: write the safety-tail as its own function -- given pool, bricks, cap,
copies, look, draws, with the rule "keep every non-brick, bottom every brick" -- and check
it against the DP on states where every clause is satisfied. If it is exact there, wire it
behind the same correct gate and the corner's absorption becomes both valid AND frequent,
since the gate no longer has to wait for a hungry clause that never mattered.
