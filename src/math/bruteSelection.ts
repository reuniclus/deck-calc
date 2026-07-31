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

function satisfied(hand: Record<string, number>, need: Need, caps?: Caps): boolean {
  for (const g of Object.keys(need)) if ((hand[g] ?? 0) < need[g]!) return false;
  if (caps !== undefined) {
    for (const g of Object.keys(caps)) if ((hand[g] ?? 0) > caps[g]!) return false;
  }
  return true;
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

/** One clause for the OR-aware brute force. */
export interface BruteClause {
  need: Need;
  caps?: Caps;
}

function satisfiedAny(hand: Record<string, number>, clauses: BruteClause[]): boolean {
  for (const c of clauses) if (satisfied(hand, c.need, c.caps)) return true;
  return false;
}

/** Is this label still worth taking for at least one clause? Greedy policy, so
 * a LOWER bound on optimal play -- with several clauses that gap is real, since
 * committing toward one clause can cost draws another needed. */
function wantedForAny(
  label: string,
  held: number,
  clauses: BruteClause[],
): boolean {
  for (const c of clauses) {
    const want = c.need[label];
    if (want === undefined || held >= want) continue;
    const cap = c.caps?.[label];
    if (cap !== undefined && held + 1 > cap) continue;
    return true;
  }
  return false;
}

function playOutDnf(
  order: string[],
  n: number,
  effect: BruteEffect,
  clauses: BruteClause[],
  clairvoyant: boolean,
): boolean {
  interface Card { l: string; seen: boolean }
  const bounded = clauses.some((c) => c.caps !== undefined);
  const keepsEverything = effect.keepMax >= effect.examined && !effect.keptCostsDraw;

  const resolve = (
    deck: Card[], hand: Record<string, number>, keptIdx: number[], window: Card[],
  ): void => {
    const kept = window.filter((_, i) => keptIdx.includes(i));
    const rejected = window.filter((_, i) => !keptIdx.includes(i));
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
  };

  // Greedy: iterative, mutating one deck array. Copying the deck per card (as
  // the clairvoyant search must) is far too slow to run over every ordering.
  if (!clairvoyant) {
    const deck: Card[] = order.map((l) => ({ l, seen: false }));
    const hand: Record<string, number> = {};
    let scheduled = n;
    while (scheduled > 0 && deck.length > 0) {
      if (satisfiedAny(hand, clauses) && !bounded) return true;
      const card = deck.shift()!;
      scheduled--;
      if (!(card.l === effect.group && !card.seen)) {
        hand[card.l] = (hand[card.l] ?? 0) + 1;
        continue;
      }
      const window = deck.splice(0, effect.examined);
      const keptIdx: number[] = [];
      window.forEach((c, i) => {
        if (keptIdx.length >= effect.keepMax) return;
        const held = (hand[c.l] ?? 0) + keptIdx.filter((j) => window[j]!.l === c.l).length;
        if (keepsEverything || wantedForAny(c.l, held, clauses)) keptIdx.push(i);
      });
      resolve(deck, hand, keptIdx, window);
    }
    return satisfiedAny(hand, clauses);
  }

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
    for (let i = 0; i < window.length; i++) {
      for (const sub of [...subsets]) if (sub.length < effect.keepMax) subsets.push([...sub, i]);
    }
    for (const sub of subsets) {
      const deck2 = rest.map((c) => ({ ...c }));
      const hand2 = { ...hand };
      resolve(deck2, hand2, sub, window.map((c) => ({ ...c })));
      if (rec(deck2, hand2, scheduled - 1)) return true;
    }
    return false;
  }

  return rec(order.map((l) => ({ l, seen: false })), {}, n);
}

/** OR-aware brute force. `clairvoyant` picks keeps with the rest of the deck
 * visible (upper bound); otherwise a greedy policy (lower bound). */
export function bruteSelectionDnfP(
  counts: Record<string, number>,
  n: number,
  effect: BruteEffect,
  clauses: BruteClause[],
  clairvoyant = false,
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
      if (playOutDnf(order, n, effect, clauses, clairvoyant)) weighted++;
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
