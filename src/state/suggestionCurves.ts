/**
 * Full curves for every distinct minimal suggested composition, deduped by
 * EXACT curve equality -- not visual similarity, not a fuzziness threshold.
 * The curve is never continuous data (boxCurve only ever produces values at
 * integer draw counts), so "same curve" is just array equality up to
 * ordinary floating-point tolerance (DP roundoff, not a design parameter).
 * A symmetric query (e.g. two groups both required at >=1, nothing else
 * distinguishing them) genuinely produces IDENTICAL curves for swapped
 * vectors like (9,10) and (10,9) -- caught and corrected once already this
 * project when an earlier mockup wrongly drew those as different lines.
 */
import { minimalVectors } from '../math/frontier';
import { normalize } from '../math/normalize';
import { evaluate } from '../math/evaluate';
import type { Box, GroupId, Sizes } from '../math/expr';
import type { Expr } from '../math/expr';

export interface SuggestionCurve {
  /** Every minimal vector that produces this exact curve. */
  vectors: Array<Record<GroupId, number>>;
  curve: Float64Array;
}

const EPS = 1e-9;

function curvesEqual(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > EPS) return false;
  return true;
}

/**
 * `clause` should be the query's OWN box (used for each group's `lo`); the
 * search itself always uses `hi = deckSize`, not the query's own `hi` --
 * that distinction is a real, once-confirmed bug (see PLAN.md/UI_DESIGN.md):
 * without it, the search could never suggest running MORE copies than the
 * deck currently has.
 */
export function computeSuggestionCurves(
  ast: Expr,
  clause: Box,
  deckSize: number,
  n: number,
  target: number,
  baseSizes: Sizes,
): SuggestionCurve[] {
  const groupIds = Object.keys(clause);
  if (groupIds.length === 0 || groupIds.length > 4) return [];

  const searchClause: Record<GroupId, { lo: number; hi: number }> = {};
  for (const g of groupIds) searchClause[g] = { lo: clause[g]!.lo, hi: deckSize };

  let vectors: Array<Record<GroupId, number>>;
  try {
    ({ vectors } = minimalVectors(searchClause, n, deckSize, target));
  } catch {
    return [];
  }

  const out: SuggestionCurve[] = [];
  for (const v of vectors) {
    const sizes: Sizes = { ...baseSizes, ...v };
    let curve: Float64Array;
    try {
      curve = evaluate(deckSize, sizes, normalize(ast, sizes)).curve;
    } catch {
      continue;
    }
    const existing = out.find((o) => curvesEqual(o.curve, curve));
    if (existing) existing.vectors.push(v);
    else out.push({ vectors: [v], curve });
  }
  return out;
}
