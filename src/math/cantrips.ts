/**
 * "How many cantrips should I run" -- modeling card-selection effects
 * (draw X, scry/look-and-keep X) in a FIXED-size deck, accounting for
 * dilution (every copy added has to come from somewhere) and the fact that
 * a cantrip only helps if it's actually been drawn.
 *
 * Model, stated explicitly (see PLAN.md's cantrip backlog section for the
 * full history of what was tried and rejected):
 *
 * - A cantrip that "sees N cards" (looks at N, keeps the useful ones) is
 *   parameterized by `bonus = N` -- the number of EXTRA cards examined
 *   beyond the one normal draw that found the cantrip itself. "Draw 1"
 *   is bonus=1; "look at 3, keep 1" is bonus=3 (what matters for finding a
 *   resource is how many cards got EXAMINED, not how many get physically
 *   kept -- the same optimal-reveal-and-keep-best reduction already
 *   established for scry elsewhere in this project).
 * - Cascading (one cantrip's own look revealing another cantrip) is NOT
 *   modeled -- each drawn cantrip contributes its bonus independently.
 *   Real values are somewhat higher than this computes.
 * - Dilution: cantrips replace "Others" (filler) first; once Others is
 *   exhausted, further copies replace an EXPLICITLY CHOSEN resource group
 *   (never silently assumed -- if a query references multiple groups,
 *   which one absorbs dilution is a real design choice with real
 *   consequences, made explicit as a caller-supplied parameter here).
 * - "How many of the cantrip drawn by turn T" is exactly hypergeometric
 *   (same deckSize throughout -- cantrips occupy deck SLOTS, they don't
 *   change the deck's total size), so the overall success rate is a
 *   weighted average over "drew 0 / drew 1 / drew 2..." scenarios, each
 *   shifting the underlying (diluted) curve by that many bonus cards.
 */
import { evaluate } from './evaluate';
import { pmf } from './hyper';
import type { Dnf, Sizes, GroupId } from './expr';

/** Diluted count of the chosen resource group after `cantripTotal` copies
 * have been added to a fixed-size deck: cuts from `othersCount` (filler)
 * first, only touches the resource once filler is exhausted. Never negative. */
export function dilutedResourceCount(originalCount: number, othersCount: number, cantripTotal: number): number {
  const overflow = Math.max(0, cantripTotal - othersCount);
  return Math.max(0, originalCount - overflow);
}

export interface CantripEffect {
  /** How many copies of this effect are in the deck. */
  count: number;
  /** Extra cards examined per drawn copy (see module doc comment). */
  bonus: number;
}

/**
 * Overall success rate by turn T, given one or more cantrip effect types in
 * the deck, diluting `dilutionGroup`'s count once `othersCount` filler
 * slots are exhausted. Exact within the two stated simplifications above
 * (no cascading; bonus = cards examined, not cards kept) -- not itself an
 * additional approximation.
 */
export function cantripSuccessRate(
  dnf: Dnf,
  fullSizes: Sizes,
  deckSize: number,
  cardsSeenByT: number,
  othersCount: number,
  dilutionGroup: GroupId,
  effects: CantripEffect[],
): number {
  const totalCantrips = effects.reduce((s, e) => s + e.count, 0);
  const dilutedCount = dilutedResourceCount(fullSizes[dilutionGroup] ?? 0, othersCount, totalCantrips);
  const dilutedSizes: Record<GroupId, number> = { ...fullSizes, [dilutionGroup]: dilutedCount };

  // Joint distribution over "how many of EACH effect type drawn by turn T"
  // -- a multivariate hypergeometric, same shape as mulligan.ts's own hand
  // enumeration, just applied to cantrip types instead of resources.
  // Effects with count=0 contribute nothing and are skipped (no free
  // dimension for a type nobody is running).
  const active = effects.filter((e) => e.count > 0);
  if (active.length === 0) {
    return evaluate(deckSize, dilutedSizes, dnf).curve[Math.min(cardsSeenByT, deckSize)] ?? 0;
  }

  let total = 0;
  function recurse(idx: number, drawnSoFar: number, probSoFar: number, bonusSoFar: number): void {
    if (idx === active.length) {
      const effectiveN = Math.min(Math.round(cardsSeenByT + bonusSoFar), deckSize);
      const p = evaluate(deckSize, dilutedSizes, dnf).curve[effectiveN] ?? 0;
      total += probSoFar * p;
      return;
    }
    const effect = active[idx]!;
    // How many of THIS type could possibly be drawn, given cards already
    // "spent" (in expectation terms this is just a cap, not a real
    // dependency -- each type's hypergeometric draw is computed against the
    // deck independently, matching how multiple resource groups are
    // already treated as independent hypergeometric axes elsewhere).
    const maxK = Math.min(effect.count, cardsSeenByT);
    for (let k = 0; k <= maxK; k++) {
      const p = pmf(deckSize, effect.count, Math.min(cardsSeenByT, deckSize), k);
      if (p <= 0) continue;
      recurse(idx + 1, drawnSoFar + k, probSoFar * p, bonusSoFar + k * effect.bonus);
    }
  }
  recurse(0, 0, 1, 0);
  return total;
}

/** ~ average marginal value per copy over a realistic 1-4 copies, for ONE
 * effect type in isolation. Telescopes to (P(4)-P(0))/4 exactly -- the
 * average of four step-wise marginals (0->1, 1->2, 2->3, 3->4) equals the
 * endpoints difference divided by 4, confirmed algebraically and
 * numerically before relying on it (see PLAN.md). One evaluation of each
 * endpoint, not four separate marginal computations. */
export function marginalValuePerCopy(
  dnf: Dnf,
  fullSizes: Sizes,
  deckSize: number,
  cardsSeenByT: number,
  othersCount: number,
  dilutionGroup: GroupId,
  bonus: number,
): number {
  const p0 = cantripSuccessRate(dnf, fullSizes, deckSize, cardsSeenByT, othersCount, dilutionGroup, [{ count: 0, bonus }]);
  const p4 = cantripSuccessRate(dnf, fullSizes, deckSize, cardsSeenByT, othersCount, dilutionGroup, [{ count: 4, bonus }]);
  return (p4 - p0) / 4;
}

/** Fewest copies of ONE effect type needed to reach `target`, searching up
 * to `maxSearch` copies. Monotone in count for a monotone query (more
 * looks never hurts), so a simple linear scan suffices -- returns null if
 * unreachable within maxSearch (never silently returns an impossible-to-
 * reach count as if it were the answer). */
export function copiesNeededForTarget(
  dnf: Dnf,
  fullSizes: Sizes,
  deckSize: number,
  cardsSeenByT: number,
  othersCount: number,
  dilutionGroup: GroupId,
  bonus: number,
  target: number,
  maxSearch: number,
): number | null {
  for (let count = 0; count <= maxSearch; count++) {
    const p = cantripSuccessRate(dnf, fullSizes, deckSize, cardsSeenByT, othersCount, dilutionGroup, [{ count, bonus }]);
    if (p >= target - 1e-12) return count;
  }
  return null;
}

/**
 * P(success by turn T | at least one of this effect has been drawn by turn
 * T) and the same conditioned on NONE having been drawn -- the "with one
 * drawn vs without" comparison. Framed as "drawn by turn T" rather than
 * specifically "seen in the opening hand" -- simpler to compute exactly
 * within this model (a single-stage weighted average over total draws by
 * T, not a two-stage opening-hand-vs-later split), and says exactly that
 * in its own naming rather than implying a narrower opening-hand-specific
 * claim it doesn't actually compute.
 */
export function successGivenDrawnVsNot(
  dnf: Dnf,
  fullSizes: Sizes,
  deckSize: number,
  cardsSeenByT: number,
  othersCount: number,
  dilutionGroup: GroupId,
  count: number,
  bonus: number,
): { givenDrawn: number; givenNotDrawn: number; pDrawn: number } {
  const dilutedCount = dilutedResourceCount(fullSizes[dilutionGroup] ?? 0, othersCount, count);
  const dilutedSizes: Record<GroupId, number> = { ...fullSizes, [dilutionGroup]: dilutedCount };
  const cappedN = Math.min(cardsSeenByT, deckSize);
  const maxK = Math.min(count, cappedN);

  let notDrawnP = 0;
  let drawnWeighted = 0;
  let pDrawnTotal = 0;
  for (let k = 0; k <= maxK; k++) {
    const pk = pmf(deckSize, count, cappedN, k);
    if (pk <= 0) continue;
    const effectiveN = Math.min(Math.round(cardsSeenByT + k * bonus), deckSize);
    const p = evaluate(deckSize, dilutedSizes, dnf).curve[effectiveN] ?? 0;
    if (k === 0) notDrawnP = p;
    else {
      drawnWeighted += pk * p;
      pDrawnTotal += pk;
    }
  }
  const givenDrawn = pDrawnTotal > 0 ? drawnWeighted / pDrawnTotal : notDrawnP;
  return { givenDrawn, givenNotDrawn: notDrawnP, pDrawn: pDrawnTotal };
}
