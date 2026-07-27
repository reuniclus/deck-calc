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
import { suggestVectors } from '../math/suggestSearch';
import { normalize } from '../math/normalize';
import { evaluate } from '../math/evaluate';
import type { Dnf, GroupId, Sizes } from '../math/expr';
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
 * Dispatches through suggestSearch.ts (fast staircase or general brute-force,
 * whichever the query shape needs) -- NOT hard-restricted to the monotone
 * single-clause case. That restriction used to live here directly, and once
 * the advisor/Suggestions tab gained general-path support, this function's
 * copy of the same check was never updated to match: phantom lines silently
 * stopped appearing for any OR/non-monotone query, even though the rest of
 * the app correctly showed suggestions for it. Confirmed and fixed directly,
 * not just patched around.
 */
export function computeSuggestionCurves(
  ast: Expr,
  dnf: Dnf,
  deckSize: number,
  n: number,
  target: number,
  baseSizes: Sizes,
): SuggestionCurve[] {
  let vectors: Array<Record<GroupId, number>>;
  try {
    ({ vectors } = suggestVectors(ast, dnf, deckSize, n, target));
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
