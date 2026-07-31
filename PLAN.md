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
- **modified-query method** -- `modifiedQuery.ts`. `hold = seen - ditched`:
  enumerate window contents, shift the query bounds by whatever was ditched,
  weight by hypergeometric, average. Shipped for CAPPED-KEEP effects (impulse)
  only. Its scry variant remains a prototype and is not committed.
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
