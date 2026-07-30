/**
 * The one shared primitive behind every "you've seen some cards, now project
 * forward" model in this project: mulligans (a reveal at the opening hand)
 * and card-selection effects (reveals during the ongoing draw process) were
 * built as two separate implementations of the same idea. This module is
 * that idea, once -- see PLAN.md's "Unifying mulligan.ts and cantrips.ts"
 * section for why the unification had to come before either model gets wired
 * into the main deck computation.
 *
 * A reveal is three separate facts, and conflating any two of them is where
 * the previous two implementations diverged:
 *
 *   1. `comp` / `total` -- which cards LEFT THE UNSEEN POOL. Everything
 *      examined leaves, whether it ended up in your hand, on top of the
 *      library, bottomed, exiled, or milled. For anything downstream of it,
 *      "bottomed" and "exiled" and "in hand" are the same fact: not coming
 *      up again in a later draw.
 *   2. `secured` -- which cards COUNT TOWARD THE QUERY. A subset of `comp`:
 *      a bottomed card left the pool but is not yours; a card kept on top is
 *      yours only once you actually spend a draw collecting it (which is the
 *      caller's job to account for, see `keptCostsDraw` in selection.ts).
 *   3. the index into the returned curve -- how many FURTHER cards get drawn
 *      after the reveal. Not part of the reveal at all, which is why this
 *      returns a whole curve rather than a point.
 *
 * Exactness scope: `secured` is applied by shifting each box's interval down
 * (see `shiftDnf`), which is exact for any query, monotone or not. What is
 * NOT decided here is which cards a player would CHOOSE to secure out of a
 * reveal -- for an up-set (all-`>=`) query that's "keep everything useful"
 * and needs no search, but for a query with an upper bound ("exactly 1 A")
 * the choice is a real optimization and belongs to the caller, which knows
 * the mechanics of the effect that produced the reveal.
 */
import { evaluate } from './evaluate';
import type { Curve } from './boxdp';
import type { Box, Dnf, GroupId, Interval, Sizes } from './expr';

/** Remaining unseen pool: count per tracked group, plus its total size
 * (untracked "other" cards are the difference, same convention as the rest
 * of the app -- never stored). */
export interface PoolState {
  sizes: Sizes;
  deckSize: number;
}

/** One reveal. `comp`/`secured` are keyed by tracked group; untracked cards
 * are implicit in `total` and can never be secured (nothing in a query
 * references them by definition). */
export interface Reveal {
  /** Tracked-group composition of every card that left the unseen pool. */
  comp: Record<GroupId, number>;
  /** Total cards that left the unseen pool, including untracked ones. */
  total: number;
  /** Of `comp`, how many count toward the query. Defaults to `comp` when
   * omitted, which is the "you keep everything you saw" case (an opening
   * hand you're keeping, a Divination-style draw). */
  secured?: Record<GroupId, number>;
}

/**
 * "You already hold `secured[g]` of group g -- you now need (lo - secured[g])
 * MORE, and may take at most (hi - secured[g]) more." Returns null when the
 * box is already violated: future draws only ever ADD to a count, so an
 * upper-bound violation from cards already in hand can never be undone.
 */
export function shiftBox(box: Box, secured: Record<GroupId, number>): Box | null {
  const shifted: Record<GroupId, Interval> = {};
  for (const g of Object.keys(box)) {
    const h = secured[g] ?? 0;
    const { lo, hi } = box[g]!;
    const newHi = hi - h;
    if (newHi < 0) return null;
    shifted[g] = { lo: Math.max(0, lo - h), hi: newHi };
  }
  return shifted;
}

/** Whole-DNF `shiftBox`. A clause violated outright is dropped, not kept as
 * an unsatisfiable one -- evaluate()'s existing handling of an empty clause
 * (already satisfied, curve of 1s) and an empty clause LIST (every clause
 * violated, curve of 0s) then covers both edge cases for free. */
export function shiftDnf(dnf: Dnf, secured: Record<GroupId, number>): Dnf {
  const clauses = dnf.clauses
    .map((c) => shiftBox(c, secured))
    .filter((c): c is Box => c !== null);
  return { clauses, monotone: dnf.monotone };
}

/** The pool left after a reveal removes `comp` from it. */
export function poolAfter(state: PoolState, groupIds: GroupId[], comp: Record<GroupId, number>, total: number): PoolState {
  const sizes: Record<GroupId, number> = { ...state.sizes };
  for (const g of groupIds) sizes[g] = (state.sizes[g] ?? 0) - (comp[g] ?? 0);
  return { sizes, deckSize: state.deckSize - total };
}

/**
 * P(query) as a function of how many FURTHER cards are drawn from the pool
 * left behind by `reveal`. The whole model, in one line each: shift the query
 * by what's already secured, shrink the pool by what's been seen, evaluate.
 *
 * Returned curve is indexed by further draws (0 = stop right here), NOT by
 * total cards seen -- callers displaying a "cards drawn" axis shift it
 * themselves, same convention `optimalMulliganCurve` already documents.
 */
export function projectForward(
  dnf: Dnf,
  groupIds: GroupId[],
  state: PoolState,
  reveal: Reveal,
): Curve {
  const secured = reveal.secured ?? reveal.comp;
  const pool = poolAfter(state, groupIds, reveal.comp, reveal.total);
  return evaluate(pool.deckSize, pool.sizes, shiftDnf(dnf, secured)).curve;
}

/** Scalar `projectForward`, clamped to the pool's own size -- drawing more
 * cards than remain is the same as drawing all of them. */
export function projectForwardAt(
  dnf: Dnf,
  groupIds: GroupId[],
  state: PoolState,
  reveal: Reveal,
  furtherDraws: number,
): number {
  const curve = projectForward(dnf, groupIds, state, reveal);
  const i = Math.min(Math.max(0, Math.round(furtherDraws)), curve.length - 1);
  return curve[i]!;
}

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 0; i < k; i++) result = (result * (n - i)) / (i + 1);
  return result;
}

/**
 * Every feasible composition of `size` cards drawn from `state`, each with
 * its EXACT multivariate-hypergeometric probability. Untracked cards fill
 * whatever's left implicitly. Used for opening hands (mulligan.ts) and for
 * the window a selection effect examines (selection.ts) -- the same
 * enumeration either way, which is most of the point of this module.
 */
export function enumerateReveals(
  groupIds: GroupId[],
  state: PoolState,
  size: number,
): Array<{ comp: Record<GroupId, number>; probability: number }> {
  const trackedTotal = groupIds.reduce((s, g) => s + (state.sizes[g] ?? 0), 0);
  const otherCount = state.deckSize - trackedTotal;
  const denom = choose(state.deckSize, size);
  const out: Array<{ comp: Record<GroupId, number>; probability: number }> = [];

  function recurse(idx: number, current: Record<GroupId, number>, remaining: number): void {
    if (idx === groupIds.length) {
      if (remaining > otherCount) return; // not enough untracked cards to fill the rest
      let numerator = choose(otherCount, remaining);
      for (const g of groupIds) numerator *= choose(state.sizes[g] ?? 0, current[g] ?? 0);
      const probability = denom > 0 ? numerator / denom : 0;
      if (probability > 0) out.push({ comp: { ...current }, probability });
      return;
    }
    const g = groupIds[idx]!;
    const maxTake = Math.min(state.sizes[g] ?? 0, remaining);
    for (let take = 0; take <= maxTake; take++) {
      recurse(idx + 1, { ...current, [g]: take }, remaining - take);
    }
  }
  recurse(0, {}, size);
  return out;
}
