# Checklist

Status of everything in flight, newest understanding first. Where an entry in PLAN.md
conflicts with this file, this file is later.

## Shipped and live

- [x] Draw-shaped cantrips card — exact, grouping-invariant, cached
- [x] Mulligan / keep-or-ship card
- [x] Copies-needed card (Questions tab) — exact hypergeometry, binary search, memoised
- [x] Empty-and-retype on **all 13** numeric inputs (`NumberInput`)
- [x] Visible deck-size presets (datalist renders nothing on mobile)

## Verified math, not yet in the UI

- [x] `manaSources.ts` — stage 1 core: `cardsSeen`, `minSources`, `sourceTable`.
      Anchored on `minSources(99,11,1,0.90) === 18`
- [x] `basicsBudget.ts` — `B <= (kL - R)/(k-1)`, per-source consistency price, and
      deck-shape requirements with **must/want** separation. Land count and draw are
      inputs, never constants
- [x] `cheapTail.ts` — exact closed-form tail for pure upper-bound queries
- [x] `triggerRecursion.ts` — exact and 2–5x faster than the DP on monotone scry
- [ ] **Colours tab** — nothing built. `manaSources` + `basicsBudget` are the slice to
      build on; they need no card catalog or collection data

## Fixed since first draft

- [x] **`basicsBudget` divisor bug.** Shipped as `B <= kL - R`, omitting that each basic
      DISPLACES a k-colour land. Coincides with the truth at `k=2`, which is why six
      duals-based checks passed; wrong from `k=3` up (claimed 60 basics for 3c triomes
      against a true 30). Found by asking about triomes. Now verified by CONSTRUCTION
      rather than by formula
- [x] Land count and requirements hard-coded at 38/18 in the tests. Now parameterised,
      with a slope test (`dB/dL = k/(k-1)`, so each land buys two basics at `k=2`)

## Known defects

- [ ] **The exact DP is grouping-dependent under scry + upper bounds** (0.795pt on a
      60-card config, 2.41pt on the arbitration config). Pinned in
      `groupingInvariance.test.ts`. Only scry is affected — draw, impulse and ponder all
      pass. Nothing shipped depends on it
- [ ] `multiType.ts` returns a HIGHER, grouping-invariant answer than the shipped DP on
      the same config, suggesting the defect is fixable. Not verified optimal; two of its
      agreement tests are marked `it.fails`
- [ ] MQ's brick error **compounds per cantrip** (×1.9 each, versus the DP's linear
      +0.7×). Fingerprinted and audited; no mechanism found. Research module, unshipped
- [ ] MQ monotone residual 0.3–0.8pt. Highest-confidence lead: `seenBefore` in
      `keepMass` uses `E[p_i]` instead of the position distribution

## Open questions, specified but not started

- [ ] Multi-type exact DP does **not scale**: 49ms → 313ms → 8022ms for 1 → 2 → 3 types.
      Your 5-type deck is out of reach. The **reduction detector** (draw ≡ impulse when
      `examined <= keepMax`) is the practical path, since `exactDrawCurveMulti` is fast
- [ ] **Composite shapes** (`scry S + draw D`) — every real cantrip is one. Preordain and
      Serum Visions are currently approximated as a plain draw bonus
- [ ] Manabase stage 1 revisions (`docs/manabase-spec.md`): per-card/per-group
      `castByTurn`, and displaying the multiplicity/brick trade rather than collapsing it
- [ ] **Mixed land types.** `basicsBudget` still takes ONE `coloursPerNonBasic`, so it
      cannot express a real 4-colour manabase mixing duals and triomes. Needs a land-type
      list (`{count, colours, isBasic}`)
- [ ] **Fetchlands.** A fetch contributes the colours of what it can FETCH, so a
      fetch-basic depends on those basics existing (zero Islands means Flooded Strand is
      not a blue source) and a fetch-any covers every colour you have a basic for. Not a
      parameter change: colour sets become derived rather than declared, and the aggregate
      identity degrades to a sanity bound with Hall's condition doing the real work
- [ ] **Deployment model** — Hall's condition over colour subsets (32 bitmask checks),
      enumerate land compositions where possible, MC only as fallback. A second model
      alongside `minSources`, not an extension
- [ ] `tapAffordance` — the spec says its current `Σ max(0, turn - mv)` is wrong in
      STRUCTURE; needs bipartite matching
- [ ] Manabase stages 2–3 (feasible region, chosen composition)

## Process debt

- [ ] Test suite is ~4 minutes, mostly report tests running the DP's 16s corner. Split
      fast/slow before it starts getting skipped
- [ ] **Three tests were found asserting bugs rather than intent** (the input snapping
      ones). A test named for what the code does is not a test of what it should do
- [ ] No render-cost probe. The typing freeze was invisible to jsdom and to unit tests
      that call a function once; it took a real phone
- [ ] PLAN.md has grown long and several entries retract earlier ones. Read the
      corrections, not just the findings
