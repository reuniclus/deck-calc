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

/** Play out one concrete deck ordering for `n` scheduled draws. */
export function playOut(order: string[], n: number, effect: BruteEffect, need: Need): boolean {
  const deck = [...order];
  const hand: Record<string, number> = {};
  // "Draw X" keeps its whole window by definition (the cards go to hand,
  // useful or not); every other shape keeps only what it wants. Derived from
  // the mechanical axes, not a separate flag.
  const keepsEverything = effect.keepMax >= effect.examined && !effect.keptCostsDraw;
  let scheduled = n;

  while (scheduled > 0 && deck.length > 0) {
    const card = deck.shift()!;
    scheduled--;
    if (card !== effect.group) {
      hand[card] = (hand[card] ?? 0) + 1;
      continue;
    }
    // Resolve the effect: examine the top `examined` cards.
    const window = deck.splice(0, effect.examined);
    const kept: string[] = [];
    const rejected: string[] = [];
    for (const c of window) {
      const wanted = need[c] !== undefined && (hand[c] ?? 0) + kept.filter((k) => k === c).length < need[c]!;
      if (kept.length < effect.keepMax && (keepsEverything || wanted)) kept.push(c);
      else rejected.push(c);
    }
    if (effect.keptCostsDraw) {
      // Kept cards go back on top: they cost subsequent scheduled draws.
      deck.unshift(...kept);
    } else {
      for (const c of kept) hand[c] = (hand[c] ?? 0) + 1;
    }
    if (effect.nonKeptLeavesPool) deck.push(...rejected); // bottomed: unreachable in practice
    else deck.unshift(...rejected.concat()); // stays on top, clogging future draws
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
      if (playOut(order, n, effect, need)) weighted++;
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
