/**
 * **TEST-ONLY.** Never import from app code (same rule as `exact.ts` and
 * `brute.ts`).
 *
 * The arbiter for selection.ts's closed forms: enumerate every distinct
 * ordering of a small deck, play each one out with the effect's REAL
 * mechanics (top of library, bottoming, exiling, hand), and count how often
 * the query is satisfied. No hypergeometric anywhere in here -- the point is
 * to be independent of every assumption selection.ts makes, so a disagreement
 * indicts the closed form rather than being a shared bug.
 *
 * Does NOT model ponder's shuffle option: this plays the no-shuffle policy
 * only, which makes it an exact check on that sub-policy and a strict LOWER
 * BOUND on optimal ponder play. Verifying the shuffle branch by simulation
 * would require averaging over fresh orderings recursively, i.e. re-deriving
 * the DP rather than independently checking it -- so ponder is verified by
 * bracketing instead (equal to this with shuffling disabled, no worse than it
 * with shuffling enabled, and never better than the same effect that can
 * bottom instead of shuffle).
 *
 * Deliberately models what selection.ts's scope statement claims NOT to
 * model, too (a drawn effect card's own look can reveal another effect card,
 * which here simply goes to hand without triggering) -- so "no cascading" is
 * a pinned, tested property of both sides rather than a hope.
 */

/** AND-of-`>=` query: how many of each label are needed. */
export type Need = Record<string, number>;

export interface BruteEffect {
  group: string;
  examined: number;
  keepMax: number;
  keptCostsDraw: boolean;
  nonKeptLeavesPool: boolean;
}

/** Upper bounds: label -> most that may be in hand. A brick/garnet group is
 * `{ K: 0 }`. Absent labels are unbounded. */
export type Caps = Record<string, number>;

/** One DNF clause: thresholds plus optional upper bounds. */
export interface BruteClause {
  need: Need;
  caps?: Caps;
}

/** Union of clauses -- satisfied when ANY of them is. */
function satisfiedAny(hand: Record<string, number>, clauses: BruteClause[]): boolean {
  return clauses.some((c) => satisfied(hand, c.need, c.caps));
}

/** Could this clause still be reached? Counts only ever rise, so a clause whose
 * upper bound is already exceeded is dead for good. */
function clauseAlive(hand: Record<string, number>, c: BruteClause): boolean {
  if (c.caps === undefined) return true;
  for (const g of Object.keys(c.caps)) if ((hand[g] ?? 0) > c.caps[g]!) return false;
  return true;
}

function satisfied(hand: Record<string, number>, need: Need, caps?: Caps): boolean {
  for (const g of Object.keys(need)) if ((hand[g] ?? 0) < need[g]!) return false;
  if (caps !== undefined) {
    for (const g of Object.keys(caps)) if ((hand[g] ?? 0) > caps[g]!) return false;
  }
  return true;
}

/**
 * Play out one ordering with SEVERAL draw-shaped effect types at once (each
 * label examines its own number of extra cards, all of which go to hand).
 * Mechanical: no hypergeometric anywhere, one card at a time, windows taken off
 * the top. Used to check `exactDrawCurveMulti`, which the previous
 * "independent" check in cantrips.test.ts could not do -- that one re-derived
 * the same closed form with local copies of the helpers, so it shared the
 * model's assumptions and validated only its arithmetic.
 */
export function playOutMultiDraw(
  order: string[],
  n: number,
  effects: Array<{ group: string; examined: number }>,
  need: Need,
): boolean {
  const deck = [...order];
  const hand: Record<string, number> = {};
  let scheduled = n;
  while (scheduled > 0 && deck.length > 0) {
    const card = deck.shift()!;
    scheduled--;
    hand[card] = (hand[card] ?? 0) + 1;
    const eff = effects.find((e) => e.group === card);
    if (eff !== undefined) {
      // Its window goes straight to hand and costs no scheduled draw. Copies
      // found inside a window do NOT trigger (no cascading).
      for (const c of deck.splice(0, eff.examined)) hand[c] = (hand[c] ?? 0) + 1;
    }
  }
  return satisfied(hand, need);
}

/** Exact P over every distinct arrangement, several draw-shaped types. */
export function bruteMultiDrawP(
  counts: Record<string, number>,
  n: number,
  effects: Array<{ group: string; examined: number }>,
  need: Need,
): number {
  return overArrangements(counts, (order) => playOutMultiDraw(order, n, effects, need));
}

/** Play out one concrete deck ordering for `n` scheduled draws.
 *
 * `cascade` controls whether an effect card that was SEEN in some window and
 * put back on top triggers when it is later drawn. That is real (Ponder
 * showing you another Ponder, which you then draw and cast) but outside
 * selection.ts's stated scope, so it defaults to off -- with it off this is an
 * exact check of the model, and turning it on MEASURES what the scope
 * assumption costs rather than leaving it as an unquantified caveat.
 *
 * Bottomed cards go to limbo rather than to the end of the array: "bottomed"
 * means unreachable, and on a tiny verification deck a pushed card really can
 * be drawn again (which showed up as a mismatch at N=11 with 7 draws, the one
 * configuration where the deck nearly runs out).
 */
export function playOut(
  order: string[],
  n: number,
  effect: BruteEffect,
  need: Need,
  cascade = false,
  caps?: Caps,
): boolean {
  interface Card { l: string; seen: boolean }
  const deck: Card[] = order.map((l) => ({ l, seen: false }));
  const hand: Record<string, number> = {};
  // "Draw X" keeps its whole window by definition (the cards go to hand,
  // useful or not); every other shape keeps only what it wants. Derived from
  // the mechanical axes, not a separate flag.
  const keepsEverything = effect.keepMax >= effect.examined && !effect.keptCostsDraw;
  let scheduled = n;

  while (scheduled > 0 && deck.length > 0) {
    const card = deck.shift()!;
    scheduled--;
    const triggers = card.l === effect.group && (cascade || !card.seen);
    if (!triggers) {
      hand[card.l] = (hand[card.l] ?? 0) + 1;
      continue;
    }
    const window = deck.splice(0, effect.examined);
    const kept: Card[] = [];
    const rejected: Card[] = [];
    for (const c of window) {
      const alreadyKept = kept.filter((k) => k.l === c.l).length;
      // A brick has need 0, so it is never "wanted" and gets refused wherever
      // refusing is possible -- which is the whole asymmetry under test.
      const wanted = need[c.l] !== undefined && (hand[c.l] ?? 0) + alreadyKept < need[c.l]!;
      if (kept.length < effect.keepMax && (keepsEverything || wanted)) kept.push(c);
      else rejected.push(c);
    }
    if (!effect.nonKeptLeavesPool) {
      // Stays on top, clogging future draws. Put back FIRST so the kept cards
      // end up above it -- optimal ordering puts what you want on top. Having
      // these the other way round made pondering come out WORSE than not
      // pondering (0.586 vs 0.618), impossible for an optional effect, which
      // is how the simulator (not the DP under test) was caught.
      for (const c of rejected) c.seen = true;
      deck.unshift(...rejected);
    }
    // else: bottomed/exiled/milled -> dropped entirely, i.e. unreachable.
    if (effect.keptCostsDraw) {
      for (const c of kept) c.seen = true;
      deck.unshift(...kept); // collected by later scheduled draws
    } else {
      for (const c of kept) hand[c.l] = (hand[c.l] ?? 0) + 1;
    }
  }
  return satisfied(hand, need, caps);
}

/**
 * Exact P(query) over every distinct arrangement of a labelled deck, each
 * equally likely. `counts` maps label -> copies; use `''` for untracked
 * filler.
 */
export function bruteSelectionP(
  counts: Record<string, number>,
  n: number,
  effect: BruteEffect,
  need: Need,
  cascade = false,
  caps?: Caps,
): number {
  const labels = Object.keys(counts);
  const remaining: Record<string, number> = { ...counts };
  const total = labels.reduce((s, l) => s + counts[l]!, 0);

  let weighted = 0;
  let arrangements = 0;
  const order: string[] = [];

  // Weight each distinct arrangement by how many labelled permutations it
  // represents -- which is 1 for every arrangement of a multiset when
  // enumerated this way, since identical copies are interchangeable. Counting
  // arrangements directly (rather than N! orderings) keeps this cheap.
  function recurse(depth: number): void {
    if (depth === total) {
      arrangements++;
      if (playOut(order, n, effect, need, cascade, caps)) weighted++;
      return;
    }
    for (const l of labels) {
      if (remaining[l]! <= 0) continue;
      remaining[l]!--;
      order.push(l);
      recurse(depth + 1);
      order.pop();
      remaining[l]!++;
    }
  }
  recurse(0);
  return arrangements > 0 ? weighted / arrangements : 0;
}

/**
 * Play out one ordering against a UNION of clauses. Same mechanics as
 * `playOut`; the keep policy wants any card that some live clause still needs,
 * which is a policy and therefore a LOWER bound once choices exist.
 */
export function playOutDnf(
  order: string[],
  n: number,
  effect: BruteEffect,
  clauses: BruteClause[],
  cascade = false,
): boolean {
  interface Card { l: string; seen: boolean }
  const deck: Card[] = order.map((l) => ({ l, seen: false }));
  const hand: Record<string, number> = {};
  const keepsEverything = effect.keepMax >= effect.examined && !effect.keptCostsDraw;
  let scheduled = n;

  while (scheduled > 0 && deck.length > 0) {
    const card = deck.shift()!;
    scheduled--;
    const triggers = card.l === effect.group && (cascade || !card.seen);
    if (!triggers) {
      hand[card.l] = (hand[card.l] ?? 0) + 1;
      continue;
    }
    const window = deck.splice(0, effect.examined);
    const kept: Card[] = [];
    const rejected: Card[] = [];
    for (const c of window) {
      const alreadyKept = kept.filter((k) => k.l === c.l).length;
      const wanted = clauses.some((cl) => clauseAlive(hand, cl)
        && cl.need[c.l] !== undefined
        && (hand[c.l] ?? 0) + alreadyKept < cl.need[c.l]!);
      if (kept.length < effect.keepMax && (keepsEverything || wanted)) kept.push(c);
      else rejected.push(c);
    }
    if (!effect.nonKeptLeavesPool) {
      for (const c of rejected) c.seen = true;
      deck.unshift(...rejected);
    }
    if (effect.keptCostsDraw) {
      for (const c of kept) c.seen = true;
      deck.unshift(...kept);
    } else {
      for (const c of kept) hand[c.l] = (hand[c.l] ?? 0) + 1;
    }
  }
  return satisfiedAny(hand, clauses);
}

/** Clairvoyant version of `playOutDnf`: keep decisions see the rest of the
 * deck, so it upper-bounds optimal play. */
export function playOutDnfClairvoyant(
  order: string[],
  n: number,
  effect: BruteEffect,
  clauses: BruteClause[],
): boolean {
  interface Card { l: string; seen: boolean }
  const bounded = clauses.some((c) => c.caps !== undefined);

  function rec(deck: Card[], hand: Record<string, number>, scheduled: number): boolean {
    const okNow = satisfiedAny(hand, clauses);
    if (okNow && !bounded) return true;
    if (scheduled <= 0 || deck.length === 0) return okNow;
    const rest = [...deck];
    const card = rest.shift()!;
    if (!(card.l === effect.group && !card.seen)) {
      const h2 = { ...hand };
      h2[card.l] = (h2[card.l] ?? 0) + 1;
      return rec(rest, h2, scheduled - 1);
    }
    const window = rest.splice(0, effect.examined);
    const subsets: number[][] = [[]];
    for (const i of window.map((_, k) => k)) {
      for (const sub of [...subsets]) if (sub.length < effect.keepMax) subsets.push([...sub, i]);
    }
    for (const keepIdx of subsets) {
      const kept = window.filter((_, i) => keepIdx.includes(i));
      const rejected = window.filter((_, i) => !keepIdx.includes(i));
      let deck2 = [...rest];
      const hand2 = { ...hand };
      if (!effect.nonKeptLeavesPool) deck2 = [...rejected.map((c) => ({ ...c, seen: true })), ...deck2];
      if (effect.keptCostsDraw) deck2 = [...kept.map((c) => ({ ...c, seen: true })), ...deck2];
      else for (const c of kept) hand2[c.l] = (hand2[c.l] ?? 0) + 1;
      if (rec(deck2, hand2, scheduled - 1)) return true;
    }
    return false;
  }

  return rec(order.map((l) => ({ l, seen: false })), {}, n);
}

/** Enumerate every distinct arrangement, scoring each with `score`. */
function overArrangements(counts: Record<string, number>, score: (order: string[]) => boolean): number {
  const labels = Object.keys(counts);
  const remaining: Record<string, number> = { ...counts };
  const total = labels.reduce((s, l) => s + counts[l]!, 0);
  let weighted = 0;
  let arrangements = 0;
  const order: string[] = [];
  function recurse(depth: number): void {
    if (depth === total) {
      arrangements++;
      if (score(order)) weighted++;
      return;
    }
    for (const l of labels) {
      if (remaining[l]! <= 0) continue;
      remaining[l]!--;
      order.push(l);
      recurse(depth + 1);
      order.pop();
      remaining[l]!++;
    }
  }
  recurse(0);
  return arrangements > 0 ? weighted / arrangements : 0;
}

/** Union-of-clauses P under the greedy keep policy (a lower bound where the
 * effect has choices, exact where it has none). */
export function bruteSelectionDnfP(
  counts: Record<string, number>,
  n: number,
  effect: BruteEffect,
  clauses: BruteClause[],
  cascade = false,
): number {
  return overArrangements(counts, (order) => playOutDnf(order, n, effect, clauses, cascade));
}

/** Union-of-clauses P under clairvoyant keeps (an upper bound). */
export function bruteSelectionDnfUpperP(
  counts: Record<string, number>,
  n: number,
  effect: BruteEffect,
  clauses: BruteClause[],
): number {
  return overArrangements(counts, (order) => playOutDnfClairvoyant(order, n, effect, clauses));
}

/**
 * Clairvoyant play-out: same mechanics, but keep decisions are made with the
 * REST OF THE DECK VISIBLE, choosing whichever commit vector can still win.
 *
 * This is an UPPER bound on optimal play, since knowing the future can only
 * help, while `playOut`'s greedy keep-in-window-order policy is a LOWER bound.
 * Together they sandwich a correct optimizer -- which is the only way to check
 * the multi-group engine by simulation: for two or more groups the keep choice
 * is a real optimization, so an exact match against any FIXED policy would
 * actually indicate the model is failing to optimize.
 */
export function playOutClairvoyant(
  order: string[],
  n: number,
  effect: BruteEffect,
  need: Need,
  caps?: Caps,
): boolean {
  interface Card { l: string; seen: boolean }

  function rec(deck: Card[], hand: Record<string, number>, scheduled: number): boolean {
    // With upper bounds, being satisfied now is not the end -- a later forced
    // draw can bust it -- so only a satisfied state at the HORIZON counts.
    const okNow = satisfied(hand, need, caps);
    if (okNow && caps === undefined) return true;
    if (scheduled <= 0 || deck.length === 0) return okNow;
    const rest = [...deck];
    const card = rest.shift()!;
    if (!(card.l === effect.group && !card.seen)) {
      const h2 = { ...hand };
      h2[card.l] = (h2[card.l] ?? 0) + 1;
      return rec(rest, h2, scheduled - 1);
    }
    const window = rest.splice(0, effect.examined);
    // Every legal choice of which window cards to commit.
    const indices = window.map((_, i) => i);
    const subsets: number[][] = [[]];
    for (const i of indices) {
      for (const s of [...subsets]) if (s.length < effect.keepMax) subsets.push([...s, i]);
    }
    for (const keepIdx of subsets) {
      const kept = window.filter((_, i) => keepIdx.includes(i));
      const rejected = window.filter((_, i) => !keepIdx.includes(i));
      let deck2 = [...rest];
      const hand2 = { ...hand };
      if (!effect.nonKeptLeavesPool) {
        deck2 = [...rejected.map((c) => ({ ...c, seen: true })), ...deck2];
      }
      if (effect.keptCostsDraw) deck2 = [...kept.map((c) => ({ ...c, seen: true })), ...deck2];
      else for (const c of kept) hand2[c.l] = (hand2[c.l] ?? 0) + 1;
      if (rec(deck2, hand2, scheduled - 1)) return true;
    }
    return false;
  }

  return rec(order.map((l) => ({ l, seen: false })), {}, n);
}

/** `bruteSelectionP` with clairvoyant keep decisions -- an upper bound. */
export function bruteSelectionUpperP(
  counts: Record<string, number>,
  n: number,
  effect: BruteEffect,
  need: Need,
  caps?: Caps,
): number {
  const labels = Object.keys(counts);
  const remaining: Record<string, number> = { ...counts };
  const total = labels.reduce((s, l) => s + counts[l]!, 0);
  let weighted = 0;
  let arrangements = 0;
  const order: string[] = [];

  function recurse(depth: number): void {
    if (depth === total) {
      arrangements++;
      if (playOutClairvoyant(order, n, effect, need, caps)) weighted++;
      return;
    }
    for (const l of labels) {
      if (remaining[l]! <= 0) continue;
      remaining[l]!--;
      order.push(l);
      recurse(depth + 1);
      order.pop();
      remaining[l]!++;
    }
  }
  recurse(0);
  return arrangements > 0 ? weighted / arrangements : 0;
}
