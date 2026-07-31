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
 * - The success rate itself comes from `exactDrawCurveMulti` (selection.ts):
 *   a sequential slot model, exact and verified against a mechanical
 *   play-out of every deck ordering.
 *
 * REPLACED 2026-07-30. This module used to compute the rate itself, as a
 * weighted average over "drew 0 / drew 1 / drew 2..." scenarios, each
 * indexing the diluted curve at `cardsSeenByT + k*bonus`. That closed form is
 * WRONG -- see PLAN.md. Conditioning on "k copies among the first n cards"
 * silently mixes two different pools (scheduled slots are known non-copies,
 * window slots come from a remainder that still holds copies), and one
 * hypergeometric cannot express both. Measured error against a real play-out
 * was 1-8 percentage points depending on effect shape and threshold, and
 * systematically ~10% LOW on marginal value per copy -- enough to have
 * recommended a 4th copy where 3 suffice.
 *
 * Two further defects went with it: each effect type drew its own independent
 * hypergeometric over the same `cardsSeenByT`, so two types could "draw" more
 * copies than cards seen; and pooling types into one averaged bonus produced
 * non-integer curve indices (CLAUDE.md #15). Neither is expressible in the
 * sequential model -- the types share one process.
 *
 * Dilution stays here. It decides the deck's COUNTS, which is a separate
 * question from how the draw process is modeled, and it belongs to this
 * exploratory tool rather than to the shared engine.
 */
import { evaluate } from './evaluate';
import { exactDrawCurveMulti, slotDistributionMulti } from './selection';
import type { Dnf, Sizes, GroupId } from './expr';

/**
 * Can this many copies actually coexist with these group counts?
 *
 * `dilutedResourceCount` clamps at zero, so asking a group with few copies to
 * absorb a lot of dilution leaves a deck that cannot exist -- groups plus
 * copies exceeding the deck size. `bestDilutionChoice` deliberately tries EVERY
 * candidate group, so it reaches those configurations routinely.
 *
 * The old closed form never noticed: it evaluated against the full deck and
 * never removed the copies from the pool, so it returned a plausible-looking
 * number for an impossible deck. The exact model conditions on the copies being
 * gone from the pool, which makes the contradiction load-bearing -- it surfaced
 * as `RangeError: constrained groups (38) exceed deck (37)` from boxdp, and
 * crashed the whole Cantrips card on mount. Infeasible configurations now score
 * 0, so an over-diluted candidate simply loses the comparison.
 */
function fitsInDeck(sizes: Sizes, deckSize: number, copies: number): boolean {
  let tracked = 0;
  for (const g of Object.keys(sizes)) tracked += sizes[g] ?? 0;
  return tracked + copies <= deckSize;
}

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
  if (!fitsInDeck(dilutedSizes, deckSize, totalCantrips)) return 0;

  // `bonus` is "extra cards examined", which is the draw-shaped effect: the
  // window goes to hand and costs no draw. Effects with count=0 contribute
  // nothing and are dropped rather than becoming a free dimension.
  const types = effects
    .filter((e) => e.count > 0)
    .map((e) => ({ count: e.count, examined: Math.round(e.bonus) }));
  const draws = Math.min(Math.max(0, Math.round(cardsSeenByT)), deckSize);
  const curve = exactDrawCurveMulti(dnf, dilutedSizes, deckSize, types, draws);
  return curve[draws] ?? 0;
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
  const draws = Math.min(Math.max(0, Math.round(cardsSeenByT)), deckSize);
  const examined = Math.round(bonus);
  if (!fitsInDeck(dilutedSizes, deckSize, count)) {
    return { givenDrawn: 0, givenNotDrawn: 0, pDrawn: 0 };
  }

  if (count <= 0) {
    const plain = evaluate(deckSize, dilutedSizes, dnf).curve[draws] ?? 0;
    return { givenDrawn: plain, givenNotDrawn: plain, pDrawn: 0 };
  }

  // Split the slot outcomes by whether any copy was seen. The slot model gives
  // the copies-seen count directly, so the condition is read off the same exact
  // distribution rather than recomputed from a separate hypergeometric -- which
  // is what let the old version's per-type draws disagree with its own totals.
  const nonEffect = evaluate(deckSize - count, dilutedSizes, dnf).curve;
  const slots = slotDistributionMulti(deckSize, [{ count, examined }], draws)[draws]!;
  let drawnWeighted = 0;
  let notDrawnWeighted = 0;
  let pDrawn = 0;
  let pNotDrawn = 0;
  for (const { seen, copies, p } of slots) {
    const idx = Math.min(Math.max(0, seen - copies), nonEffect.length - 1);
    const value = p * (nonEffect[idx] ?? 0);
    if (copies > 0) { drawnWeighted += value; pDrawn += p; }
    else { notDrawnWeighted += value; pNotDrawn += p; }
  }
  const givenNotDrawn = pNotDrawn > 0 ? notDrawnWeighted / pNotDrawn : 0;
  return {
    givenDrawn: pDrawn > 0 ? drawnWeighted / pDrawn : givenNotDrawn,
    givenNotDrawn,
    pDrawn,
  };
}

/**
 * Which of several candidate groups should absorb dilution, chosen EXACTLY
 * rather than by a heuristic like "whichever has the most copies" -- that
 * heuristic is usually right (a group with many copies already has a high
 * per-copy hit rate, so losing one hurts least) but not ALWAYS: a query
 * like "A>=3 OR B>=1" can make the more-populous group the actual
 * bottleneck, not the safe one to cut. Since candidate groups are always
 * few (this app caps queries at 4 tracked groups) and evaluate() is cheap,
 * there's no reason to guess -- just try every candidate directly and keep
 * whichever one actually gives the highest resulting success rate.
 */
export function bestDilutionChoice(
  dnf: Dnf,
  fullSizes: Sizes,
  deckSize: number,
  cardsSeenByT: number,
  othersCount: number,
  candidateGroups: GroupId[],
  effects: CantripEffect[],
): { group: GroupId; rate: number } {
  let best = candidateGroups[0]!;
  let bestRate = -Infinity;
  for (const g of candidateGroups) {
    const rate = cantripSuccessRate(dnf, fullSizes, deckSize, cardsSeenByT, othersCount, g, effects);
    if (rate > bestRate) {
      bestRate = rate;
      best = g;
    }
  }
  return { group: best, rate: bestRate };
}

/** Same as marginalValuePerCopy, but re-picks the best dilution target at
 * each of the two endpoints (0 and 4 copies) via bestDilutionChoice, rather
 * than requiring one fixed group up front. */
export function marginalValuePerCopyAutoDilute(
  dnf: Dnf,
  fullSizes: Sizes,
  deckSize: number,
  cardsSeenByT: number,
  othersCount: number,
  candidateGroups: GroupId[],
  bonus: number,
): number {
  const p0 = bestDilutionChoice(dnf, fullSizes, deckSize, cardsSeenByT, othersCount, candidateGroups, [{ count: 0, bonus }]).rate;
  const p4 = bestDilutionChoice(dnf, fullSizes, deckSize, cardsSeenByT, othersCount, candidateGroups, [{ count: 4, bonus }]).rate;
  return (p4 - p0) / 4;
}

/** Same as copiesNeededForTarget, but re-picks the best dilution target at
 * EACH candidate count tried, rather than fixing one choice for the whole
 * search -- the best group to dilute can shift as count grows (e.g. once
 * one group's own count has been fully diluted away). */
export function copiesNeededForTargetAutoDilute(
  dnf: Dnf,
  fullSizes: Sizes,
  deckSize: number,
  cardsSeenByT: number,
  othersCount: number,
  candidateGroups: GroupId[],
  bonus: number,
  target: number,
  maxSearch: number,
): number | null {
  for (let count = 0; count <= maxSearch; count++) {
    const { rate } = bestDilutionChoice(dnf, fullSizes, deckSize, cardsSeenByT, othersCount, candidateGroups, [{ count, bonus }]);
    if (rate >= target - 1e-12) return count;
  }
  return null;
}
