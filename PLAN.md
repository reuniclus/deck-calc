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
