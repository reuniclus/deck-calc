# Manabase machinery — spec

Handoff document. Authoritative over any code currently in `src/`. Where they
disagree, the spec wins; see [Delta](#delta-against-current-code).

## Architecture

Three stages, strict one-way interfaces.

```
stage 1   cards            → requirements, joint[], tapAffordance, cutCurve
stage 2   requirements, L  → limits and extremes of the feasible region
stage 3   region, catalog  → a chosen point, named cards
```

Stage 1 depends only on the spell list. Stage 2 depends only on stage 1's output
plus a land count. Stage 3 is the only stage that knows what cards exist, what
they cost, or what the user owns.

This factorisation is the point: budget and collection change often, `S` rarely.
Stage 1 is computed once per decklist; stage 2 once per `(S, L)`; stage 3 every
time availability changes.

### Interface contract

```ts
// stage 1 → stage 2
interface Stage1Result {
  requirements: ColorMap;          // S_c. ONE vector. no brackets.
  joint: JointConstraint[];        // multicolour predicates, unevaluated
  tapAffordance: number;           // global, colourless, integer
  cutCurve: Record<Color, number[]>;
  ranked: Record<Color, Demand[]>;
  totalPips: ColorMap;
  impossible: Demand[];
}

// stage 2 → stage 3
interface Stage2Result {
  active: Color[]; m: number; rungs: number[];
  slackMax: number;
  cells: Cell[];                   // per (L, dead)
  passthrough: { joint: JointConstraint[]; tapAffordance: number };
}
```

`joint[]` and `tapAffordance` pass through stage 2 **untouched**. Stage 2 is
composition-blind and timing-blind; it cannot evaluate either.

---

## Stage 1

### Inputs

```ts
interface Card {
  name: string;
  mv: number;
  pips: Partial<Record<Color, number>>;
  castByTurn?: number;   // deadline. defaults to mv.
}

interface DeckConfig {
  deckSize: number;        // 99 | 60 | 40
  openingHand: number;     // 7
  drawsOnFirstTurn: boolean; // true for EDH multiplayer, false on the play
  confidence: number;      // 0.90
}
```

`confidence` is a single scalar. There is no `jointMode` — see
[Why no joint correction here](#why-no-joint-correction-here).

### Sampling window

```
cardsSeen(cfg, T) = min(deckSize, openingHand + (drawsOnFirstTurn ? T : T - 1))
```

EDH: `seen(T) = 7 + T`. So `seen(4) = 11`.

Known optimism, inherited from Karsten: assumes every land drawn is played on
curve, and that cards seen equals cards available. Not corrected.

### Requirement solve

```
minSources(N, n, k, q):
    if k <= 0: return 0
    if k > n: return Infinity
    if P(>=k | K=N) < q: return Infinity        # unreachable at any count
    binary search smallest K in [k, N] with hypergeomAtLeast(N, K, n, k) >= q
```

`hypergeomAtLeast` computed via the lower tail (short for small k), using
log-gamma for `lnChoose`. Monotone nondecreasing in `K`, which is what licenses
the binary search.

**Anchor test — must hold:**

```
minSources(99, cardsSeen(EDH, 4), 1, 0.90) === 18
hypergeomAtLeast(99, 17, 11, 1) < 0.90
```

Specific to EDH multiplayer, where every player draws on turn 1 so `seen(4) = 11`.
In 1v1 Commander the starting player skips that draw, `seen(4) = 10`, and the
anchor becomes ~~19~~ **20**. The config field exists for exactly this reason; do
not hard-code 18.

> **CORRECTION (deck-calc, 2026-07-30).** The reasoning is right and the number was
> off by one. Verified independently of any shared code, with plain products:
> `n=10, K=18 -> 0.879430`; `K=19 -> 0.894315`, still under 0.90; `K=20 -> 0.907526`,
> the first count that clears it. The multiplayer anchor of 18 is correct at
> 0.903815, inside the stated 0.903-0.905 window, so the error is confined to this
> 1v1 remark. Pinned in `src/math/manaSources.test.ts`.

### Per-colour floors

```
for each card, for each colour c with pips[c] > 0:
    turn = castByTurn ?? mv
    demand = { card, colour: c, k: pips[c], turn,
               seen: cardsSeen(cfg, turn),
               sources: minSources(deckSize, seen, k, confidence) }
    if !finite(sources): impossible.push(demand)
    else ranked[c].push(demand)

sort each ranked[c] descending by sources
requirements[c] = ranked[c][0]?.sources ?? 0
cutCurve[c]     = ranked[c].map(d => d.sources).concat(0)
```

**The floor is a max, not a sum.** 20 cards at k=1 and 10 cards at k=2 both
total 20 pips; their floors differ by ~10 sources. `totalPips` is emitted for
stage 3 tiebreaking only — never for computing a floor.

`cutCurve` is what makes stage 2 re-runnable. Stage 2 infeasible → step down
`cutCurve[c]` one index and re-run. A steep first drop means one fragile card
sets the floor; a flat curve means it is structural.

### Joint constraints

A multicolour card has **no per-colour requirement**. `{W}{U}{G}` at T3 is a
constraint on the joint distribution, not three numbers.

```ts
interface JointConstraint {
  card: string;
  pips: Partial<Record<Color, number>>;  // >1 distinct colour
  turn: number;
  seen: number;
  q: number;
}
```

Emit as an unevaluated predicate. Still contribute the card's per-colour `k` to
`ranked`/`requirements` as a lower bracket (necessary), but do not inflate it.

#### Why no joint correction here

Earlier design applied `q^(1/m)` per colour. Rejected for two reasons:

1. **Wrong stage.** Independence across colour-events is a fact about
   *composition* — one Command Tower satisfies the W, U and G checks with a
   single card. Composition is stage 3 data.
2. **Circular.** Higher floors → more forced overlap (stage 2) → more
   correlation → smaller correction → lower floors.

`q^(1/m)` is a valid worst-case bound for any composition, so it is technically
composition-free, but it is loose exactly where manabases are dense in high-rung
lands. Direction is provable: shared lands make colour-events positively
correlated, so exact ≥ independent. Magnitude is unknown without a composition.

Resolve exactly at stage 3 via multivariate hypergeometric over land types.

### tapAffordance

Two costs, unrelated. Only the second is modelled here.

- **Cost A — colour arrival.** A tapped source must be *played* a turn earlier,
  sampling `seen(T-1)` instead of `seen(T)`. One card of window, ≈+1.5 sources
  for a fully tapped base. Depends on tapped fraction → stage 3.
- **Cost B — mana on the turn played.** A tapland played turn `t` yields `t-1`
  available mana that turn. Colourless, pure scheduling against the curve.
  Stage 1.

```
deadline(c) = castByTurn ?? mv
horizon     = max over cards of deadline(c)

Θ ⊆ {1..horizon}                       # turns hosting a tapland
available(t) = t - (t ∈ Θ ? 1 : 0)

feasible(Θ) ⟺ ∃ injective assignment card → turn with
                 turn ≤ deadline(card) and mv(card) ≤ available(turn)

tapAffordance = max |Θ| over feasible Θ
```

Exact by enumeration: `horizon` is small (<= ~6), so enumerate all `Θ` in
`2^horizon` <= 64 cases and test each for a feasible assignment via bipartite
matching (Hall's condition on cards → turns). Do not use a greedy
latest-deadline-first heuristic and call it exact — maximising `|Θ|` is a choice
over subsets, and greedy over cards does not search it.

Modelling assumption: **one spell per turn**. Real turns cast several, which makes
this a ceiling on the constraint and therefore a ceiling on affordance.

Conservative closed form, pinning each card at its deadline:

```
need(t) = max{ mv(c) : deadline(c) == t }, else 0
safe(t) = need(t) <= t - 1
tapAffordance >= count of safe t in 1..horizon
```

Understates: a card with mv 2 / deadline 4 may sit on turn 2, 3 or 4.

**It is global, not per-colour.** Cost B is about total mana available on a turn,
which is colourless. Which colours the taplands produce is stage 3 assignment.

**It is a count of turn slots, not a sum over cards.** Two flexible cards that
would both occupy turn 5 give one free turn, not two.

Return a definite integer given a complete curve. `need(1)` must be determined,
not assumed — an empty turn 1 is worth exactly one tapland.

Theoretical ceiling: assumes every land drop hit and free sequencing (a tapland
drawn exactly on a safe turn). Honest use is "am I over it", not "am I at it".

---

## Stage 2

Consumes `S: ColorMap`, land count `L` (scalar or range), `R` = off-land
any-colour source count. Emits **limits and extremes**. Never a recommendation.

### Active set and effective rung

```
A = { c : S_c > 0 }        m = |A|
rung(land) = |produces(land) ∩ A|
```

Rung is **effective, not printed**. A WUBRG rainbow in a deck with
`S = {W:30, U:29, G:18}` is rung 3. Oversatisfied splash colours drop out of the
maths automatically.

### Available rungs

| m | rungs | collapses | profile dim |
|---|---|---|---|
| 1 | {1} | everything | −1 (degenerate) |
| 2 | {1,2} | rainbow ≡ tri ≡ dual | 0 (forced) |
| 3 | {1,2,3} | rainbow ≡ tri | 1 |
| 4 | {1,2,3,4} | rainbow alone at 4 | 2 |
| 5 | {1,2,3,**5**} | — | 2 |

m=5 is the only case with a hole: printed cycles exist at r = 1, 2, 3, 5, and no
printed cycle taps for exactly 4 named colours, so a five-colour base overshoots
to rainbow or settles for a Triome. This is a fact about the card pool, not the
maths — if a rung-4 cycle is printed, `rungs(5)` gains a 4 and `r2` changes. At m=4 the hole closes because rainbow restricted to `A` *is* rung 4.

**Short-circuit at m=1.** Profile dim −1, no overlap, no pairwise minima,
Gale–Ryser vacuous, `avgRung` forced to 1. The whole stage reduces to
`dead = L - S_U + R`, which stage 1 already determines. Return early.

### Feasibility

```
S_c ← max(0, S_c - R)   for each c
C = L - dead
feasible ⟺ C >= max_c S_c
slackMax = L - max_c S_c
```

No land makes two white. That is the entire gate.

**The density bound is vacuous — do not emit it.** Since `E <= m · max_c S_c`,
we have `ceil(E/m) <= max_c S_c` always. It can never bind, at any m.

### Edge identity

```
E = ΣS_c                  edges, fixed by stage 1
avgRung = E / C           the ONLY free variable at this level
totalOverlap = E - C      forced
E/L <= avgRung <= min(m, E / max_c S_c)
```

Requirements do not translate into a composition. They translate into an **edge
count**; the choice is how densely to pack those edges.

### Profile family

`n_r` = colored lands of effective rung `r`.

```
Σ_r n_r = C
Σ_r r · n_r = E
dim = |rungs(m)| - 2
```

### Realizability gate — Gale–Ryser

**The two profile equations are necessary but not sufficient.** A profile can
satisfy both and still be unrealizable. Gate with Gale–Ryser:

```
S sorted descending
∀k in 1..m:   Σ_{c=1..k} S_c  <=  Σ_r n_r · min(r, k)
```

This is exactly the bigraphic-degree-sequence condition: colours have degrees
`S_c`, lands have degrees `r_i`, and `Σ r_i = E = Σ S_c` by construction. It is
necessary *and* sufficient for the profile.

Illustration at m=3, C=39, S=(30,29,18), E=77: the profile `19 rainbow + 20
basics` satisfies `Σn_r = 39` and `Σ r·n_r = 77`, yet is unrealizable — 19
rainbow covers G outright, leaving W+U needing 11+10 = 21 basics in 20 slots.
Gale–Ryser catches it at k=2: `59 > 58`.

At m=3 the gate collapses to one usable inequality: `n_1 <= 2C - (S_1 + S_2)`.

**Do not describe pairwise minima as the weaker test that this example defeats.**
That framing is a category error, and the example does not support it — `19
rainbow` gives `|W∩U| = 19` against a pairwise floor of 20, so it fails the
pairwise bound as well. The two objects are not comparable: Gale–Ryser gates the
**rung profile**, pairwise minima constrain the **subset assignment** (a rung
profile does not determine `|W∩U|`). Emit both, describe neither as subsuming the
other.

### Closed forms

```
r2 = second-highest available rung in rungs(m)
min n_m = max(0, ceil( (E - r2 · C) / (m - r2) ))
```

Each top-rung land substituted for an `r2` land buys `m - r2` extra edges.
Threshold is `E` vs `r2 · C`; each dead land moves `min n_m` by
`r2 / (m - r2)`.

At m=3 (`r2 = 2`) this reduces to `max(0, E - 2C)`, moving by 2 per dead land:
`E <= 2C` → zero rainbow/tri needed, duals + basics suffice.

**Do not simplify to `max(0, E - (m-1)·C)`.** That assumes `r2 = m - 1`, which
fails at m=5 because no rung 4 exists (see the rungs table). At `E=140, C=40,
m=5`: the simplified form gives 0, the correct form gives 10.

```
pairMinima[ab] = max(0, S_a + S_b - C)   necessary-only; label as such
```

Emit anyway — it is the interpretable form, and the one that predicts a
budget collision before any budget data exists.

### Cells

```
for L in range:
  for dead in 0..slackMax:
    C = L - dead
    enumerate integer n over rungs(m) satisfying both profile equations
    keep those passing Gale–Ryser for all k
    emit { L, dead, C, avgRung, totalOverlap, minTopRung, pairMinima, profiles }
```

`profiles` is the deliverable. Every other field is a one-line recomputation
from `S` and `C`.

### What stage 2 must refuse

- **Ranking profiles.** `min n_m` is a vertex, not an answer. It presumes cost
  rises with rung, which is false: a tapped Triome (r=3, cheap) beats a
  shockland (r=2, expensive). Cost ordering is stage 3's.
- **Which duals** (WU vs WG vs UG) — assignment, a further `2^m - m - 2`
  dimensions.
- Evaluating `joint[]`, assigning tapland colours, cost A.
- The one-land-drop-per-turn coupling across colours.

### Worked example

`S = {W:30, U:29, G:18}`, `L=39`, `R=0`, `m=3`, `E=77`, `slackMax=9`,
`avgRung ∈ [1.97, 2.57]`

The family at m=3 is one-parameter in `n_3`, via the identity

```
n_1 = 2C - E + n_3            n_2 = C - n_1 - n_3
min n_3 = max(0, E - 2C)      (n_1 >= 0)
```

Rows below are the `min n_3` vertex of each cell:

```
dead  C   n3  n2  n1   pairMin WU/WG/UG   avgRung
  0   39   0  38   1      20 / 9 / 8       1.97
  3   36   5  31   0      23 /12 /11       2.14
  6   33  11  22   0      26 /15 /14       2.33
  9   30  17  13   0      29 /18 /17       2.57
```

Raising `n_3` by one raises `n_1` by one and lowers `n_2` by two — that is the
lateral `rainbow + basic ↔ dual + dual` move, and it sweeps the whole family.

Extremes: min-slots vertex at C=30, dead=9 (greedy yields `18 rainbow + 11 dual +
1 basic`, a valid `n_3 = 18` point of that cell). Min-overlap vertex `38 dual + 1
basic`, C=39, dead=0. Both hit `S` exactly.

**Note the earlier revision of this table pinned `n_1 = 1` on every row**, which
made `n_3` read as a minimum when rows 3/6/9 sat one above it. Emit the identity,
and label whichever vertex is shown.

Generating move: `rainbow + basic ↔ dual + dual` is **lateral** — 2 slots,
4 edges either way. That is where cost lives, and it is invisible to stage 2.

### Degenerate check (m=1)

`S = {U:40}`, `L=38..42`, `R=0`:

```
E=40, avgRung=1 forced, C=40, totalOverlap=0, profile dim=-1
dead = L - 40 + R      → -2 at L=38, 0 at L=40, 2 at L=42
```

Overlap machinery scales with `2^m - m - 2`. Mono-colour has nowhere to hide, so
utility lands trade 1:1 against Islands.

---

## Land classes

Every land in play taps once. Each is `(colorSet, capacity=1)`. What differs is
**when the colorSet is fixed**.

| class | colorSet fixed | rung(k=1) | rung(k>=2) | slot | notes |
|---|---|---|---|---|---|
| basic | print | 1 | 1 | yes | fetch target |
| dual | print | 2 | 2 | yes | re-choosable each turn |
| tri | print | 3 | 3 | yes | |
| rainbow | print | m | m | yes | effective rung, not printed |
| pathway | at play, locked | 2 | **1** | yes | untapped, no contention |
| fetch | at play, locked | **\|B\|** | **1** | yes | tapped; depletes basic pool |
| MDFC | print (land face) | 1 | 1 | **no** | discount by P(cast spell face) |
| rock / dork | n/a | 1 | 1 | **no** | folds into `R` |

`B` = set of colours with at least one basic in the deck. Fetch rung is
**endogenous** — a function of the profile, not unmodelable. Enumerate an outer
loop over `B ⊆ A` (≤ 2^m, trivial); inside each, fetch rung is constant and the
profile equations are linear again.

### Commit-once family

Pathway and fetch are land-guaranteed with a colorSet locked at play. MDFC is
**not** in this family — its flexibility is land-vs-spell, and its land face is
permanently monocoloured, so it belongs with rocks as off-slot supply.

For a single `k=1` check, commit-once is equivalent to re-choosable at equal
rung: a Pathway in play taps for one mana of one colour, same as a dual. The
equivalence **degrades at k>=2 in one turn** (two duals can be tapped W+U for
`{W}{U}`; two Pathways both locked to W cannot), and degrades further across
turns (a dual taps W on T3 and U on T5).

Hence rung is **per-k**, and the coverage system is evaluated twice:

```
k=1 system:   fetch → |B|,  pathway → 2
k>=2 system:  fetch → 1,    pathway → 1
```

Both must hold. Fetch-heavy compositions pass the first and fail the second.

### Fetch pool constraint

```
Σ (fetches) <= Σ_c n_basic[c]
```

Fetches and basics **compete** for the same cards; they do not stack. 1 Forest +
2 Evolving Wilds is three cards contending for one Forest. No rung accounting
shows this.

### Colourless ramp is not a source

Sol Ring, Mind Stone, Everflowing Chalice contribute **zero** to any `S_c`. `R`
requires actual coloured production (Fellwar Stone, Chromatic Lantern, Sky
Diamond, Signets, Talismans). Colourless ramp additionally *accelerates*, pulling
casts earlier and pushing floors **up** — a `{U}{U}{U}` moved T4 → T3 goes
40 → 44. Do not credit it.

---

## Stage 3 (not yet specified)

Owns: cost/tier ordering over land classes, the assignment problem
(`x_P` for `P ⊆ A`), availability caps, exact evaluation of `joint[]`, tapland
colour assignment, cost A.

Assignment system:

```
find x_P >= 0 integer, P ⊆ A nonempty, dead >= 0
    Σ_P x_P + dead = L
    Σ_{P ∋ c} x_P + R_c >= S_c    ∀c ∈ A
```

`>=` not `=`: over-coverage is often forced — a rainbow bought for W hands you
U and G whether wanted or not. Free dimension `2^m - m - 2`.

Canonical minimal-slot realization, greedy on residual demand:

```
residual ← S
while any residual > 0:
    P ← the <= m colours with greatest residual
    emit one land with colorSet P
    residual[c] -= 1 for c in P
```

Reaches the min-slots vertex, `C = max_c S_c`. Each land supplies at most one
edge per colour, so `max_c S_c` is a lower bound on slots and greedy attains it.
Note this is the **min-slots** vertex, not the max-`n_m` one — at C=30 in the
worked example it returns `n_3 = 18` while `min n_3 = 17`.

Joint evaluation: multivariate hypergeometric over land types, DP on capped
per-colour counts.

Rocks are the cheapest lever in the model: each any-colour rock decrements every
`S_c`, hence `max_c S_c`, hence `slackMax += 1`, while consuming no land slot. It
also drops `E` by `m`, hence `min n_m` by `m / (m - r2)` — which is `m` only when
`r2 = m - 1`, so at m=5 it is `5/2`, not 5. That asymmetry — coloured constraints but not the slot
constraint — is the formal reason rocks dissolve availability caps.

---

## Known omissions

Signed by direction of error on floors.

| omission | effect |
|---|---|
| independence approx across colours (if used) | conservative |
| fetch counted multi-colour at k=1 | optimistic |
| no draw / selection / mulligan modelling | conservative |
| cards seen ≠ cards available | optimistic |
| cross-card simultaneity (`{W}{W}` + `{U}` same turn) | **optimistic** |
| ramp pulling casts earlier than mv | **optimistic** |
| one-land-drop-per-turn coupling across colours | optimistic |
| tapAffordance assumes free sequencing | optimistic |

The two starred rows concentrate in the 2–3 drop band. Both are what would
eventually force Monte Carlo.

**Retracted claim, do not reintroduce:** additive per-colour counting is *not*
badly optimistic due to matching failures. Hall's condition at singleton `Y` is
the per-colour count; at `Y = A` it is `Σk_c <= lands in play`, already enforced
by the mana-count check. Only intermediate `Y` is new, and for real casting costs
it rarely binds. The two multicolour errors run opposite ways (independence
conservative, shared-land double-count optimistic) and partially cancel; net
direction unknown without computing.

---

## Delta against current code

`src/` contains a working implementation with 20 passing tests. It predates
several decisions above. Required edits:

1. **`src/types.ts`** — delete `jointMode` from `DeckConfig` and from the `EDH` /
   `SIXTY` / `LIMITED` presets. It is policy masquerading as deck structure.
2. **`src/stage1.ts`** — delete `perColorConfidence`. Floors use the bare
   `confidence` scalar.
3. **`src/stage1.ts`** — `taplandTolerance = Σ max(0, turn - mv)` is **wrong in
   structure**, not just placement. Replace with the `tapAffordance` matching
   algorithm above. Slots do not add.
4. **`src/stage1.ts`** — add `joint: JointConstraint[]` to `Stage1Result`, emitted
   unevaluated.
5. **`src/stage2.ts`** — delete `bounds.byDensity` and the `binding` field.
   Vacuous.
6. **`src/stage2.ts`** — add the profile enumeration + Gale–Ryser gate. Currently
   emits only scalars and pairwise minima, which is the necessary-only shell of
   the region.
7. **`src/stage2.ts`** — short-circuit at `m === 1`.
8. **`src/stage2.ts`** — `geometry` should accept an `L` range and emit cells, not
   take a scalar.
9. **`src/stage3.ts`** — `solve` is a max-dead covering DFS and is roughly right
   in shape, but does not yet know per-k rung, the fetch pool constraint, or
   `joint[]` evaluation. Land classes need the table above.
10. **Do not add** `requirementsConservative`. One requirement vector.

Retain as-is: `src/hypergeometric.ts` (correct, and the anchor test pins it),
`cardsSeen`, `minSources`, `cutCurve`, `castProbability`, the `landPool` helper.

### Test invariants to preserve

```
minSources(99, 11, 1, 0.90) === 18
hypergeomAtLeast(99, 18, 11, 1) ∈ (0.903, 0.905)
hypergeomAtLeast(99, 17, 11, 1) < 0.90
floor is a max not a sum:  10 cards @k=2  -  20 cards @k=1  >= 8 sources
pip step >> turn step:     (k=2 vs k=1) > 3 × (T4 vs T6)
geometry({W:30,U:29,G:18}, 39).slackMax === 9
pairMinima at dead=0: WU 20, WG 9, UG 8; tripleMin WUG 0
each dead land adds exactly 1 to totalOverlap
each any-colour rock adds exactly 1 to slackMax
{W:44} at L=39 is infeasible
19 rainbow + 20 basics at C=39, S=(30,29,18) fails Gale-Ryser at k=2 (59 > 58)
m=1 short-circuits: no profiles, no pairMinima, dead = L - S_c + R
```

Regression tests for the four corrected errors — these must fail against the
pre-correction spec:

```
min n_m at (E=140, C=40, m=5, rungs {1,2,3,5}) === 10        not 0
profile identity holds: n_1 === 2C - E + n_3 for all m=3 cells
min n_3 at C=36, E=77 === 5                                  not 6
19 rainbow + 20 basics ALSO violates pairMinima WU (19 < 20)
  -> it is not evidence that Gale-Ryser is stronger than pairwise
rungs(5) contains no 4, so r2 === 3 and (m - r2) === 2
```

---

## Corrections log

Errors found in the first draft of this spec, verified numerically, fixed above.
Listed so a reader does not re-derive them from an earlier copy.

| # | error | correct |
|---|---|---|
| 1 | `min n_m = max(0, E - (m-1)C)` stated as generic | `max(0, ceil((E - r2·C)/(m - r2)))`. The simplified form assumes `r2 = m-1`, false at m=5 where rung 4 does not exist. At `E=140, C=40, m=5` it gives 0 against a true 10. |
| 2 | `19 rainbow + 20 basics` offered as a profile that passes pairwise minima but fails Gale–Ryser | It fails both — `\|W∩U\| = 19` against a pairwise floor of 20. It is still a valid illustration that the two **profile equations** are insufficient, which is what Gale–Ryser gates. Pairwise minima and Gale–Ryser constrain different objects and neither subsumes the other. |
| 3 | Worked-example table silently pinned `n_1 = 1` on all rows, so `n_3` read as a minimum | `min n_3 = max(0, E-2C)` gives 0/5/11/17, not 0/6/12/18. Emit the identity `n_1 = 2C - E + n_3`. |
| 4 | rock lever described as `min n_m -= m` | `m / (m - r2)`, so 5/2 at m=5. Same root cause as #1. |
| 5 | tapAffordance called exact via "greedy latest-deadline-first" | Maximising `\|Θ\|` is a search over subsets; enumerate `2^horizon` (≤64) and matching-test each. |
| 6 | greedy realization labelled the "max-overlap vertex" | It is the **min-slots** vertex, `C = max_c S_c`. At C=30 it returns `n_3 = 18` while `min n_3 = 17`. |
| 7 | anchor `= 18` presented as a property of 99-card decks | Property of EDH *multiplayer* (`seen(4) = 11`). 1v1 Commander gives `seen(4) = 10` and an anchor of 19. |
| 8 | m=5 rung hole stated as a fact about the maths | Fact about the printed card pool. If a rung-4 cycle is printed, `rungs(5)` and `r2` change. |

Root cause of #1 and #4 is the same: assuming the available rung set is
contiguous `1..m`. It is not, at m=5. Any formula referencing `m-1` as "the rung
below the top" is suspect — use `r2` from `rungs(m)`.

---

# Revision notes (deck-calc, 2026-07-30)

Three gaps found while reviewing stage 1 against extreme cases. The first two are
parameterisation; the third needs a second model.

## The requirement surface, measured

`minSources` over (pips, turn), EDH 99 at 90%:

| pips | T1 | T2 | T3 | T4 | T5 | T6 | T8 | T10 |
|---|---|---|---|---|---|---|---|---|
| 1 | 24 | 22 | 20 | **18** | 17 | 16 | 14 | 12 |
| 2 | 40 | 36 | 33 | **30** | 28 | 26 | 23 | 20 |
| 3 | 53 | 48 | 44 | **40** | 38 | 35 | 31 | 27 |

**A turn step costs ~2 sources; a pip step costs ~12.** So `requirements[c] = max(...)`
is set almost entirely by the highest-PIP card of that colour, and barely at all by
timing. The collapse is into pip count, not into early turns.

## 1. `castByTurn` defaults are right for the curve, wrong for splashes

Defaulting to `mv` is correct for a card you intend to cast on curve. It is wrong for a
splash: a single `{U}` card defaults to `castByTurn = 1` and demands 24 sources, when
what the player wants is "available at some point", not "on turn one".

The field already exists, so this is not a model change -- it is a DEFAULT and a UI
affordance. Deadline must be adjustable per card, and per GROUP for bulk edits, and
visible rather than silent. The model cannot infer intent here and should not try.

## 2. Multiplicity versus bricking: display the trade, do not pick for the user

`1x {W}{W}{W}` and `30x {W}{W}{W}` both yield 40. Those are different decks. And the
fragile-outlier case (`1x {W}{W}` at T2 needing 36, alongside `30x {W}` at T6 needing
16) is a genuine tension, not an error: the 1-of really might brick, and avoiding that
is what a manabase is for.

But both sides are computable, so neither needs to be guessed:
- **cost** of insuring the outlier: 36 - 16 = **20 sources**
- **benefit**: P(draw it early AND cannot cast it), from the same hypergeometric

So present "this 1-of costs 20 sources; without them it bricks in X% of games" and let
the user decide. `cutCurve` already holds exactly this data; collapsing it to index 0 is
what discards it. The spec's own escape hatch -- step down `cutCurve` and re-run -- is a
concession that index 0 is frequently the wrong answer.

## 3. Simultaneous casting: a second model, and Hall's condition is the tool

The spec states the limit itself: *"one spell per turn. Real turns cast several, which
makes this a ceiling."* The sharp case: 2 Plains + 5 Wastes casts `{4}{W}` and casts
`{W}{W}`, but cannot do both on T7. Per-card analysis sees only the first two facts,
because it asks about each card independently.

**The inner question is exactly solvable and cheap.** "Can this set of lands pay for
this set of spells" is bipartite matching from lands to pips, and by Hall's condition
reduces to: for every subset `S` of colours,

```
sum of pips demanding a colour in S  <=  # lands producing some colour in S
```

plus `total lands >= total MV`. That is `2^5 = 32` bitmask checks for five colours --
exact, microseconds, no sampling. The 2-Plains case falls out immediately: `S = {W}`
gives 3 pips > 2 sources, infeasible, while each spell alone passes.

Note this is the SAME Gale-Ryser / Hall machinery the spec already specifies for stage
2's feasible region. The tool is in the design; it is simply not applied to deployment.

**Only the outer layer needs sampling, and often not even that:**

| land classes x lands drawn | method |
|---|---|
| few classes (<=5), <=10 lands | ENUMERATE compositions exactly (multivariate hypergeometric) x Hall per composition -> exact |
| many classes | Monte Carlo the draw, Hall per sample |

Monte Carlo is the fallback, not the primary. When sampling, report the interval:
standard error is `sqrt(p(1-p)/n)`, so ~250k samples for 0.1pt. Each sample is 32
bitmask checks, so that is affordable -- but the honest output is `47.3% +/- 0.2`, not
`47.3%`.

**Suggested metric:** not "is my curve castable" (binary and brittle) but EXPECTED MANA
OR SPELLS DEPLOYED by turn T. That is what the Plains/Wastes case is really about, and
it degrades gracefully instead of flipping.

**This is a separate model, not an extension of `minSources`.** Karsten's method is
per-card sampling by construction; deployment is a joint property of hand and board. The
two should sit side by side, and disagreement between them is expected rather than a
bug -- the "one spell per turn" note is precisely the seam where one ends and the other
begins.

## The even-distribution heuristic (deck-calc, 2026-07-30)

The one table to start from. EDH 99, 38 lands, castable by T4 (`n = 11`), 90%
confidence, requirements spread evenly across colours, no musts.

| colours | pips | req/colour | rho | need k >= | k=2 | k=3 | k=4 | k=5 |
|---|---|---|---|---|---|---|---|---|
| 2c | 1 | 18 | 0.95 | 1 | **100%** | 100% | 100% | 100% |
| 2c | 2 | 30 | 1.58 | 2 | 42% | 42% | 42% | 42% |
| 3c | 1 | 18 | 1.42 | 2 | 58% | 79% | 79% | 79% |
| 3c | 2 | 30 | 2.37 | **3** | — | 32% | 32% | 32% |
| 4c | 1 | 18 | 1.89 | 2 | 11% | 55% | 70% | 70% |
| 4c | 2 | 30 | 3.16 | **4** | — | — | 28% | 28% |
| 5c | 1 | 18 | 2.37 | **3** | — | 32% | 54% | 66% |
| 5c | 2 | 30 | 3.95 | **4** | — | — | 2% | 26% |

`basics%` is a fraction of LANDS. `k` is capped at the colour count, since breadth beyond
your colours does nothing -- which is why the rows flatten to the right.

Three readings:

- **A second pip costs more than a second colour.** 3c at one pip is `rho = 1.42`; 2c at
  two pips is `rho = 1.58`. Adding a whole colour is cheaper than doubling a pip.
- **Double pips force breadth.** Two pips across three colours needs triomes at minimum;
  across four it needs four-colour lands; across five it needs four-plus and still leaves
  2% basics. This is the arithmetic behind "double-pip costs in four-colour decks are a
  trap".
- **`need k > colours` means no manabase works.** Not "build it better" -- land-only
  cannot reach it, and the answer is mana rocks, dorks, or fewer pips. A deck wanting
  `{G}{G}{G}` by T4 lands here: 40 sources against 38 lands.

Caveats carried from the sections below: this assumes an EVEN spread, so it says nothing
about a 10/20/70 colour split (use `coverage` for that), and `rho <= k` is necessary
rather than sufficient (use `checkSupply` to verify a real composition).

## The even-distribution heuristic (deck-calc, 2026-07-30)

Assumes an even colour spread and no musts. Generated by `evenDistributionTable` rather
than hard-coded, so it cannot drift from the functions it summarises and can be
regenerated for another format, confidence, pip count or turn.

### Step 1 -- `phi`, required sources as a percentage of the deck (EDH 99, 90%)

| | T3 | T4 | T5 | T6 |
|---|---|---|---|---|
| 1 pip | 20.2% | **18.2%** | 17.2% | 16.2% |
| 2 pips | 33.3% | **30.3%** | 28.3% | 26.3% |
| 3 pips | 44.4% | **40.4%** | 38.4% | 35.4% |

### Step 2 -- basics as a percentage of lands, one pip by T4

`rho = colours * phi / lambda`, then `beta = (k - rho)/(k - 1)` with `k` capped at the
colour count. Cells are **duals / triomes**.

| lands | lambda | 2c | 3c | 4c | 5c |
|---|---|---|---|---|---|
| 34 | 0.343 | 94% / 94% | 41% / 71% | — / 44% | — / 18% |
| 36 | 0.364 | 100% / 100% | 50% / 75% | 0% / 50% | — / 25% |
| **38** | 0.384 | 100% / 100% | **58% / 79%** | **11% / 55%** | — / 32% |
| 40 | 0.404 | 100% / 100% | 65% / 83% | 20% / 60% | — / 37% |
| 42 | 0.424 | 100% / 100% | 71% / 86% | 29% / 64% | — / 43% |

Three readings:

- **Land count moves basics about 7pt per land** at three colours off duals (41 -> 50 ->
  58 -> 65 -> 71). That is the substitution rate between running MORE lands and running
  BETTER lands.
- **Five colours off duals is infeasible at every land count**, 34 through 42. Not a
  tuning problem -- the land type is wrong.
- **Four colours is the knife edge**: 0% basics at 36 lands, 29% at 42. Nowhere else does
  the answer swing so hard on land count, which is why four-colour manabases feel
  unforgiving.

Skewed decks are NOT covered by this table -- see `rhoProfile` for the per-colour view and
`coverage` for the share-weighted one.

## Reference tables in RATIO form (deck-calc, 2026-07-30)

The count tables below are a worked instance; these are the general statement. Because
`beta = (k - rho)/(k - 1)` depends only on `rho` and `k`, ONE table covers every deck
size, land count, colour count and format. Deck specifics enter solely through
`rho = Phi/lambda`.

### Basics as a percentage of lands

| rho | k=2 | k=3 | k=4 | k=5 |
|---|---|---|---|---|
| 1.0 | 100% | 100% | 100% | 100% |
| 1.2 | 80% | 90% | 93% | 95% |
| 1.4 | 60% | 80% | 87% | 90% |
| 1.6 | 40% | 70% | 80% | 85% |
| 1.8 | 20% | 60% | 73% | 80% |
| 2.0 | 0% | 50% | 67% | 75% |
| 2.4 | — | 30% | 53% | 65% |
| 2.8 | — | 10% | 40% | 55% |
| 3.2 | — | — | 27% | 45% |

(`rho < 1` gives `beta > 100%`, i.e. all basics with room to spare. Clamp at 100%.)

### Colourless utility lands as a percentage of lands, `1 - rho/k`

| rho | k=2 | k=3 | k=4 | k=5 |
|---|---|---|---|---|
| 1.2 | 40% | 60% | 70% | 76% |
| 1.6 | 20% | 47% | 60% | 68% |
| 2.0 | 0% | 33% | 50% | 60% |
| 2.4 | — | 20% | 40% | 52% |
| 2.8 | — | 7% | 30% | 44% |

### `rho` for common decks (phi = 0.182 at n = 11, one pip, 90%)

| deck | lambda | rho |
|---|---|---|
| 2c EDH, 38 lands | 0.384 | 0.95 |
| 3c EDH, 38 lands | 0.384 | 1.42 |
| 4c EDH, 38 lands | 0.384 | 1.90 |
| 5c EDH, 38 lands | 0.384 | 2.37 |
| 3c EDH, **30 lands** | 0.303 | **1.80** |
| 3c 60-card, 24 lands | 0.400 | **1.36** |

Two things the ratio form shows that the count tables concealed:

- **Cutting lands costs about as much as adding a colour.** Taking a three-colour EDH
  deck from 38 lands to 30 moves `rho` from 1.42 to 1.80, i.e. 58% basics down to 20% --
  comparable to the jump from three colours to four.
- **Three-colour 60-card is EASIER than three-colour EDH** (`rho` 1.36 against 1.42),
  because 24/60 is a higher land fraction than 38/99. Formats are not ranked by deck
  size; they are ranked by `lambda`.

## Reference tables in COUNT form (a worked instance of the above)

EDH 99, 38 lands, **no cantrips** (n = 11 by T4), one pip, 90% confidence, even colour
spread, no musts. Requirement is 18 sources per colour.

### Basics affordable

Breadth is capped at the deck's colour count: a rainbow in a two-colour deck IS a dual,
and a WUB triome in a WU deck is a WU dual. (An earlier version of this table omitted
that cap and wrongly credited a three-colour deck with 34 basics off rainbows.)

| colours | duals | triomes | rainbow / fetch-any |
|---|---|---|---|
| 2 | 38 (all) | 38 | 38 |
| 3 | 22 | 30 | 30 |
| 4 | **4** | 21 | 26 |
| 5 | **infeasible** | 12 | 25 |

The two-colour row being flat across all three columns is the check that the cap is
applied: extra breadth cannot help a deck that has no further colours to reach.

### Where fetchlands sit

For the BUDGET, a fetch is a non-basic whose breadth is how many of your colours it can
reach, so it maps onto a column above rather than needing one of its own:

- **fetch-any** (Prismatic Vista, Fabled Passage) -> the rightmost column
- **fetch-basic** (Flooded Strand and friends) -> the duals column, reaching two colours

That is why fetches fix so well: they buy triome-or-better breadth on a land that is
otherwise a basic-fetcher.

The budget is not the whole story for them, though. `landTypes.ts` tracks a second
quantity the budget cannot see: fetches multiply ACCESS to targets without multiplying
the targets, so a fetch only counts if the basics it wants are actually in the deck, and
`distinct[c] >= pips` still has to hold. One Island plus ten fetches satisfies every
budget here and still cannot cast `{U}{U}`.

Upper bound from the budget identity; a constructed composition typically lands one
lower, since the identity ignores integrality and colour assignment.

### Colourless utility lands

A utility land produces no coloured mana, so it contributes zero colour-slots and reduces
the effective land count: `B <= (k(L-U) - R)/(k-1)`, feasible iff `U <= L - R/k`.

**Each utility land costs `k/(k-1)` basics** -- two with duals, 1.5 with triomes, 1.25 with
rainbows. Broader lands make utility lands cheaper, which is not obvious before writing it
down.

Maximum utility lands before colour fails (breadth capped at colour count):

| colours | duals | triomes | rainbow / fetch-any |
|---|---|---|---|
| 2 | 20 | 20 | 20 |
| 3 | 11 | 20 | 20 |
| 4 | **2** | 14 | 20 |
| 5 | — | 8 | 20 |

Four colours off duals supports two colourless utility lands; five supports none. That
matches how such decks are built in practice, which is the reason to trust the table.
