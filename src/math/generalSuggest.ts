/**
 * General (non-monotone-safe) minimal-vector search. frontier.ts's
 * minimalVectors relies on monotonicity (a single up-set box) to use an
 * efficient staircase walk -- that shortcut is NOT available once a query
 * has a NOT/upper-bound (non-monotone) or multiple OR'd clauses, because
 * increasing one group's count can help satisfy one clause while hurting
 * another. There is no staircase to walk in general.
 *
 * This module instead brute-force enumerates every composition of the
 * query's own groups within the deck's capacity, evaluates the FULL query
 * (evaluate()/normalize() already handle inclusion-exclusion and negation
 * correctly regardless of clause count) at each point, and Pareto-filters
 * the results reaching target down to the minimal ones. It is exhaustive
 * WITHIN A HARD CAP, not clever -- correct by construction (no shortcut to
 * get wrong), but only usable for a small number of groups. Use ONLY when
 * the fast monotone/single-clause path doesn't apply.
 */
import { evaluate } from './evaluate';
import { normalize } from './normalize';
import type { Expr, Sizes, GroupId } from './expr';

export class SearchTooLargeError extends Error {}

export interface GeneralSuggestResult {
  bestP: number;
  vectors: Array<Record<GroupId, number>>;
}

const MAX_COMBOS = 60_000;

/** Binomial coefficient, stopping early (returning Infinity) once it's
 * clearly past any threshold we'd compare it against -- avoids overflow
 * for large n without needing exact precision past that point. */
function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
    if (result > 10 * MAX_COMBOS) return Infinity;
  }
  return result;
}

export function generalMinimalVectors(
  ast: Expr,
  groupIds: GroupId[],
  deckSize: number,
  n: number,
  target: number,
  baseSizes: Sizes,
): GeneralSuggestResult {
  if (groupIds.length === 0) return { bestP: 1, vectors: [] };
  if (groupIds.length > 4) {
    throw new SearchTooLargeError(`${groupIds.length} groups referenced -- exhaustive search is capped at 4`);
  }
  // Exact upper bound on combinations with sum(v) <= deckSize (stars and
  // bars: C(deckSize + groupIds.length, groupIds.length)) -- NOT a loose
  // heuristic. An earlier fudge-factor estimate let an obviously-too-large
  // case (deckSize=1000, 2 groups) slip past the pre-check and grind through
  // thousands of expensive evaluate() calls before the mid-scan cap finally
  // fired, timing out a test at 5s. This bound is checked BEFORE any
  // evaluate() call runs at all.
  if (choose(deckSize + groupIds.length, groupIds.length) > MAX_COMBOS) {
    throw new SearchTooLargeError(
      `search space too large for a ${deckSize}-card deck with ${groupIds.length} groups`,
    );
  }

  let bestP = 0;
  let visited = 0;
  const feasible: Array<Record<GroupId, number>> = [];

  function evalAt(v: Record<GroupId, number>): number {
    const sizes: Sizes = { ...baseSizes, ...v };
    return evaluate(deckSize, sizes, normalize(ast, sizes)).curve[n]!;
  }

  function recurse(idx: number, current: Record<GroupId, number>, remaining: number): void {
    if (idx === groupIds.length) {
      visited++;
      if (visited > MAX_COMBOS) throw new SearchTooLargeError(`exceeded ${MAX_COMBOS} evaluated combinations`);
      const p = evalAt(current);
      if (p > bestP) bestP = p;
      if (p >= target - 1e-12) feasible.push({ ...current });
      return;
    }
    const g = groupIds[idx]!;
    for (let v = 0; v <= remaining; v++) {
      recurse(idx + 1, { ...current, [g]: v }, remaining - v);
    }
  }
  recurse(0, {}, deckSize);

  // Pareto-minimal: keep a feasible vector only if no OTHER feasible vector
  // dominates it (every coordinate <=, at least one strictly <).
  const minimal = feasible.filter((a, i) =>
    !feasible.some((b, j) =>
      j !== i && groupIds.every((g) => b[g]! <= a[g]!) && groupIds.some((g) => b[g]! < a[g]!)));

  return { bestP, vectors: minimal };
}
