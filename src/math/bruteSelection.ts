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

function satisfied(hand: Record<string, number>, need: Need): boolean {
  for (const g of Object.keys(need)) if ((hand[g] ?? 0) < need[g]!) return false;
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
  return satisfied(hand, need);
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
      if (playOut(order, n, effect, need, cascade)) weighted++;
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
