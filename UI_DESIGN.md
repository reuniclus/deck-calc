# UI Design — layout, combos card, advisor, curve/grid

This is the real product's information architecture, decided through a mockup pass
(no code) after the harness's feature-by-feature vertical stack proved every panel
was equal-weight and the page kept growing. Nothing here is built yet; PLAN.md
covers the math and harness, this covers the actual UI that will eventually replace
the harness. Palette/type deliberately deferred — everything below is CSS-variable
driven so color/type is a late, independent decision (see §7).

## 0. The job of the page

*Tell me how likely I am to draw what I need, and what to change if I'm not likely
enough.* Audience is analytically-minded deckbuilders (MTG/Yu-Gi-Oh/etc.) who want
precision, not a playful consumer-app skin.

## 1. Layout

```
┌────────────┬──┬─────────────────────────┐
│ Deck+Turns │  │ Advisor strip (always)  │
├────────────┤  ├─────────────────────────┤
│ Combos     │  │ hero curve              │
│            │  ├─────────────────────────┤
│            │  │ Chart Table Grid All opt│
└────────────┴──┴─────────────────────────┘
   resizable   drag
     rail      handle
```

Rejected alternatives and why, for when this gets revisited:
- **A "command strip on top"** (deck/query/turns as one horizontal band, everything
  else below) — cheapest change from the harness, but doesn't fix the long-scroll
  problem; every output panel still stacks vertically underneath.
- **Persistent left rail, but ALL outputs (chart/table/grid/advisor) also stacked
  vertically underneath** — makes inputs persistent but doesn't solve the real
  problem, which is that chart/table/grid/advisor are four *lenses on the same
  computation*, not four different topics that belong in a scroll.

The chosen layout treats the probability curve as the page's thesis (the one
characteristic visual, always visible) and moves table/grid/advisor-detail into
tabs beneath it.

### Rail contents
One merged card, deck + turns, **no card title** — deck size, the colored group
list, and a collapsed turns row (hand size · mulligans) are already self-labeling;
a generic heading above them added nothing. Below it, the Combos card (§2).

### Rail resize
Draggable divider between the rail and main content.
- Min/max clamp: roughly 180–450px. Below ~180 the combo accordion's real-name
  rows stop fitting on one line; above ~450 the rail stops being a rail and starts
  eating the hero curve's space.
- Hit target ~8px even though the visible bar is ~3px; brightens on hover
  (`--border` → `--border-strong`) so it's discoverable without being a visible
  line down the page at rest.
- **Desktop only.** Mobile collapses the rail into a drawer regardless (§8, not
  yet designed), so there's no rail to drag there.
- **Persisted to `localStorage`, not part of the shareable/exported state.** This
  is a "how I like to look at it" preference, same bucket as target %, turn
  config, and grid display mode — none of which belong in the export/URL hash
  (§6).
- Default rail width tested at ~220–240px with realistic multi-word names
  (`Blink ETB`, `Blink Spell`, `Hand Traps`) fitting on one line without needing
  the handle; 200px was too tight. Ship the default around there, not narrower.

## 2. Combos card

### The shape (already built in code, `src/math/builder.ts`)
A query is a union of **combos** (OR'd together); each combo is a plain AND of
conditions. This *is* the whole flat model — no separate "all of these / any of
these / at least N" modes, because they're all the same shape at different
parameter values (see PLAN.md §4b/§4c for why the earlier per-combo threshold
idea was removed).

### Normal case: accordion, not tabs
Considered tabs first (each combo as a tab, tab label = that combo's own
condition text) because they're more compact with short placeholder names
(`A≥1`, `B≥1`). **Rejected after retesting with realistic names.** A combo like
`Blink ETB≥1 & Blink Spell≥1` has to wrap inside a tab pill, producing a ragged,
uneven-height tab strip — exactly the "tidy row of pills" property that made tabs
attractive in the first place evaporates the moment labels are realistic length.
Shorthand punctuation (`!Hand Traps`) also reads like a typo next to real English
words in a way it didn't next to a single letter.

Accordion degrades gracefully by comparison: a multi-condition combo wraps
*within its own row* instead of fighting siblings for width, and reads as an
actual sentence (`Blink ETB ≥ 1 and Blink Spell ≥ 1`, `not Hand Traps`) rather
than compressed syntax.

Accepted cost, explicitly not optimized away: a **single-condition combo
collapses to 1 line; a multi-condition combo collapses to 2–3 lines**, even
though it isn't being edited. Considered and rejected two ways to force a hard
1-line cap (truncate + tooltip; show only group names, hiding thresholds until
expanded) — both trade away "read it without touching anything," which is the
accordion's actual advantage over tabs. Given the realistic range is 2–3 combos
(confirmed with the person building this — 5+ combos "seems hard to even
imagine right now," not fully discounted but not designed for), worst case is
roughly 3 combos × 2 lines ≈ 6 lines, still shorter than the hero curve above it.

### Behavior
- Each combo row toggles independently. Expanding one does **not** auto-collapse
  the others — the person may want two combos open side by side to compare them,
  and the whole point of choosing accordion over tabs was to never force choosing
  between combos.
- A newly-added combo starts expanded. Everything else keeps whatever state it
  already had.
- Collapsing is manual (the row's own chevron) — nothing auto-closes on its own.
- No separate "reads as" summary sentence above the accordion. Tried this
  (colored prose sentence + accordion rows below) and it was pure duplication —
  the collapsed rows already show full text. Cut entirely, not just de-emphasized.
- `not X`, never `!X`, once real names are involved (see above).

### Fallback: real nesting the flat model can't represent
Already solved in the math layer (`decompileFlat` returns `null` for genuine
nesting an OR-of-AND-combos can't express, e.g.
`((a&b)&(c|d)|(e))|(e&(a|!(b&c)))`). The design question was only how this reads
in the new IA:
- **All-or-nothing**, not per-combo. One un-representable piece anywhere in the
  query drops the *entire* card to text, even if most of it would fit the flat
  model. A partial fallback (some combos as accordion rows, one shown as "too
  nested, edit inline") is possible but meaningfully harder to build correctly,
  and this is explicitly an edge case ("unrealistic... though I wouldn't entirely
  discard the idea"). Build all-or-nothing now; revisit partial only if people
  actually hit this.
- Card keeps the same "Combos" label and position. No separate heading, no
  "error" styling — this is a capability boundary, not a failure. Message:
  *"This combo structure is too nested for the builder. Edit it as text."* Plain
  statement of what happened, no apology, a next step. Textarea takes over the
  card's content entirely; the "Edit as text" toggle link doesn't appear in this
  state since there's no structured view to switch back to.
- **What's lost:** color-coded, structured mirroring. `printExpr` can still
  render any nesting depth as valid, accurate, re-parseable text — so the
  fallback is never *wrong*, it just isn't colorized. True syntax highlighting
  inside the fallback textarea (color group names live as you type, matching
  their dot colors) would close this gap but is a real editor feature, not a
  mockup-pass decision — **backlog, not blocking.**

## 3. Advisor strip

Persistent, above the hero curve, visible regardless of which tab (Chart /
Table / Grid) is active — not a tab itself. Earlier design had this as a 4th tab
("Path to target"); moved out once it was clear the advisor's whole value is
being the "so what do I do" answer, which shouldn't require a click to see.

Condensed copy, not the full breakdown:
```
Goal: 90% success rate by turn 4
Draw 23 cards (13 more). Or add 2 Blink ETB, 2 Blink Spell.
See all options →
```
- "Goal: X% by turn T" states the target plainly, no preamble.
- "(N more)" is *drawsNeeded minus the cards already drawn by the chosen turn*,
  not drawsNeeded restated — the number that's actually actionable ("13 more
  than you'd already have") rather than a repeat of the raw total.
- Multiple copy suggestions are joined inline with their group's color dot next
  to the name — avoids the ambiguity of a slash-separated "X/Y/Z copies of
  A/B/C" list where pairing numbers to names isn't visually obvious.
- "See all options" is its own **tab** ("All options"), not an inline expand —
  the full breakdown (every minimal vector, best split of current slots, fewest
  slots for target) is substantial enough content that it deserves the same
  treatment as Grid, not a section that pushes the curve down when opened.

## 4. Curve: suggested-composition lines replace blind ±1/±2

The harness's phantom fan (every group, ±1/±2 copies, colored by group) was
useful for local sensitivity but not for "what should I actually do" — the
interesting alternative composition is rarely exactly ±1 or ±2 away, which is
plausibly *why* the grid kept getting used instead: the fan's offsets were
arbitrary, the grid could show the actually-relevant cell.

**New behavior:** when the advisor has computed real suggestions (the query is a
single monotone AND-clause, so `minimalVectors` applies), the curve plots one
line per **distinct** suggested composition — not the closest one, not capped
for clutter. Reasoning from the person building this: "if 19 minimal vectors
produce the same success rate, 1 line suffices... I'm not worried about clutter
as much as I'm worried about the info being useless."

- **Each suggested line is a full curve** (every n, not just a marker at the
  target turn) for that whole alternative composition applied jointly — e.g. "9
  Blink ETB AND 10 Blink Spell together," not two separate single-group phantom
  lines. A suggestion is inherently joint; showing it any other way misrepresents
  what's being recommended.
- **Dedup by exact curve equality**, not visual similarity or a fuzziness
  threshold. Caught and corrected a real mistake here mid-design: an early
  mockup drew 4 different-looking lines for `(8,11)`, `(9,10)`, `(10,9)`,
  `(11,8)`, but for a symmetric query (both groups required at the same
  threshold, nothing else distinguishing them), swapping which group gets which
  count produces the mathematically **identical** curve at every single n, not
  just a similar one — 4 vectors, 2 real distinct curves. Also resolved: no
  fuzzy "how close counts as close" judgment call is needed at all, because the
  curve is never continuous data — `boxCurve` only ever produces values at
  integer draw counts, so "same curve" is exact array-equality (index by index)
  up to ordinary floating-point tolerance (~1e-9, DP roundoff, not a design
  parameter).
- **Tied compositions live in the hover/click detail**, not on the graph. A line
  shared by `(8,11)` and `(11,8)` shows both compositions when inspected,
  reusing the existing hover/click tooltip mechanism (already built for the
  harness's phantom curves) extended to list N compositions instead of assuming
  exactly one.
- **Fallback:** when there's nothing to suggest (already at target, or the query
  isn't a single monotone AND-clause so the advisor tools don't apply), revert to
  the old blind ±1/±2 fan rather than showing nothing.

## 5. "All options" tab / table

Gets the same dedup treatment as the curve, for the same reason (a table row
per vector is just as redundant as a graph line per vector, once two vectors are
provably tied). One row per distinct outcome; tied vectors listed **as whole
stacked tuples** within that row (`8, 11` then `11, 8` on their own lines) —
never as independent per-column "or" lists (e.g. column A says "8 or 11", column
B says "8 or 11" independently), which would silently imply invalid combinations
like `(8,8)` that were never actually valid.

## 6. Export / share

Not yet mocked in detail, but decided:
- **Auto-synced to the URL hash** (`#`, not `?query params` — never hits the
  server, doesn't trigger navigation via `history.replaceState`, no query-string
  length limits some proxies impose) on every change to deck size, groups,
  copies, or the query.
- **Base64url-encoded compact JSON** in the hash — a URL is a token to paste, not
  a document to read.
- **The existing human-readable JSON textarea stays**, as the "I want to
  read/hand-edit this" path, separate from the "just share a link" path.
  Two formats, same state, different jobs.
- `history.replaceState`, never `pushState` — updating on every keystroke must
  not pollute back-button history.
- Target %, turn config, grid display mode, and rail width are session/view
  preferences (`localStorage`), **not** part of the shared/exported state — same
  reasoning as §1's rail width.

## 7. Palette / type — deferred on purpose

CSS-variable driven throughout, so this is a late, swappable decision, not baked
into layout choices above. Direction floated but not committed: avoid the three
generic AI-design defaults (warm cream+serif+terracotta; near-black+neon; hairline
broadsheet). Lean into the functional color system that already exists
(hue-rotated per-group colors, diverging warm/cool for deltas) as the actual
signature — "every card group has a color, and that color follows it into every
view" — rather than inventing a separate decorative brand palette that competes
with it. A distinct accent (considered: brass/amber, "instrument panel" framing)
for UI chrome, separate from the data hues. Not decided; revisit deliberately,
not by drifting into a default while building something else.

## 8. Mobile — not yet designed

Open question, next up. Rail becomes *something* other than a fixed-width
sidebar (drawer? accordion? bottom sheet?) — not decided.

## Backlog (raised during this pass, not resolved — do not "fix" silently later)

1. **Mulligans are modeled wrong for how the game actually works.** Current
   approximation (`effectiveOpeningHand = openingHand - mulligans`, see
   `model/turns.ts`) implies progressively *smaller draws* (7, then 6, then 5...).
   That's not what happens: a player always draws a fresh 7 every mulligan and
   only *afterward* bottoms however many the mulligan count owes — the
   information they act on is never smaller than 7, only what they get to *keep*
   shrinks. Needs the real order-statistic model (draw 7, keep your best
   `7-mulligans`), which for a single tracked group is a closed-form transform
   of the univariate hypergeometric, but for a general multi-group boolean query
   "best subset" isn't well-defined without knowing which combination is being
   optimized for. Real math project, not a parameter tweak — see PLAN.md §3c.
2. **Turn 0 vs turn 1 collapse under "on the play."** `cardsSeenByTurn(0)` and
   `cardsSeenByTurn(1)` currently return the *same* value whenever "on the play"
   is checked, because turn 1 on the play skips its draw — correct per the rule,
   but means the advisor's "by turn" input can't distinguish turn 0 from turn 1
   in that state, which reads as a bug even though the underlying rule is right.
   Decide: should "turn 1" always mean hand+1 regardless of the on-the-play
   toggle (treating "skip the draw" as an orthogonal flag rather than something
   that collapses two turn numbers together), or should turn 0 stop being an
   offered input when on the play? Not resolved.
