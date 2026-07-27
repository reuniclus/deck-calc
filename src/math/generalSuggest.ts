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
 *
 * Split into two steps deliberately: enumerateCompositionCurves() is the
 * expensive part (evaluate() per composition, up to MAX_COMBOS of them) and
 * does NOT depend on n/target at all -- only on the query, its groups, and
 * the deck size. pickMinimalVectors() is a cheap array scan that depends on
 * n/target. A caller that keeps the deck+query fixed and only changes the
 * goal (the common case -- see useSuggestions.tsx) can compute the curves
 * ONCE and re-run pickMinimalVectors() as many times as the goal changes,
 * instead of re-running the whole expensive enumeration every time.
 * generalMinimalVectors() below is a thin wrapper doing both steps for
 * anyone who doesn't need that caching (e.g. one-shot use, tests).
 */
import { evaluate } from './evaluate';
import { normalize } from './normalize';
import type { Expr, Sizes, GroupId } from './expr';

export class SearchTooLargeError extends Error {}

export interface GeneralSuggestResult {
  bestP: number;
  vectors: Array<Record<GroupId, number>>;
}

export interface CompositionCurve {
  vector: Record<GroupId, number>;
  curve: Float64Array;
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

/** The expensive step: every composition's FULL curve, independent of
 * n/target. Throws SearchTooLargeError before running any evaluate() call
 * at all if the exact (not estimated) budget-constrained bound exceeds the
 * cap -- see the git history for why an earlier loose-heuristic version of
 * this check let an oversized case grind for seconds before a mid-scan cap
 * finally fired. */
export function enumerateCompositionCurves(
  ast: Expr,
  groupIds: GroupId[],
  deckSize: number,
  baseSizes: Sizes,
): CompositionCurve[] {
  if (groupIds.length === 0) return [];
  if (groupIds.length > 4) {
    throw new SearchTooLargeError(`${groupIds.length} groups referenced -- exhaustive search is capped at 4`);
  }
  if (choose(deckSize + groupIds.length, groupIds.length) > MAX_COMBOS) {
    throw new SearchTooLargeError(
      `search space too large for a ${deckSize}-card deck with ${groupIds.length} groups`,
    );
  }

  const out: CompositionCurve[] = [];
  let visited = 0;

  function recurse(idx: number, current: Record<GroupId, number>, remaining: number): void {
    if (idx === groupIds.length) {
      visited++;
      if (visited > MAX_COMBOS) throw new SearchTooLargeError(`exceeded ${MAX_COMBOS} evaluated combinations`);
      const sizes: Sizes = { ...baseSizes, ...current };
      const curve = evaluate(deckSize, sizes, normalize(ast, sizes)).curve;
      out.push({ vector: { ...current }, curve });
      return;
    }
    const g = groupIds[idx]!;
    for (let v = 0; v <= remaining; v++) {
      recurse(idx + 1, { ...current, [g]: v }, remaining - v);
    }
  }
  recurse(0, {}, deckSize);
  return out;
}

/** The cheap step: no evaluate() calls at all, just scans already-computed
 * curves for a specific n/target. */
export function pickMinimalVectors(
  compositionCurves: CompositionCurve[],
  groupIds: GroupId[],
  n: number,
  target: number,
): GeneralSuggestResult {
  let bestP = 0;
  const feasible: Array<Record<GroupId, number>> = [];
  for (const { vector, curve } of compositionCurves) {
    const p = curve[n]!;
    if (p > bestP) bestP = p;
    if (p >= target - 1e-12) feasible.push(vector);
  }

  // Pareto-minimal: keep a feasible vector only if no OTHER feasible vector
  // dominates it (every coordinate <=, at least one strictly <).
  const minimal = feasible.filter((a, i) =>
    !feasible.some((b, j) =>
      j !== i && groupIds.every((g) => b[g]! <= a[g]!) && groupIds.some((g) => b[g]! < a[g]!)));

  return { bestP, vectors: minimal };
}

/** Convenience one-shot wrapper (both steps, no caching) -- for callers that
 * don't keep the deck+query fixed across repeated calls, e.g. tests. */
export function generalMinimalVectors(
  ast: Expr,
  groupIds: GroupId[],
  deckSize: number,
  n: number,
  target: number,
  baseSizes: Sizes,
): GeneralSuggestResult {
  if (groupIds.length === 0) return { bestP: 1, vectors: [] };
  const curves = enumerateCompositionCurves(ast, groupIds, deckSize, baseSizes);
  return pickMinimalVectors(curves, groupIds, n, target);
}
