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
 *
 * Takes ALREADY-COMPUTED vectors (from the shared useSuggestionsCtx()) --
 * does NOT run its own search. It used to call suggestVectors() internally,
 * which meant the same expensive search ran redundantly here AND in
 * AdvisorStrip AND in SuggestionsTab on every goal change; consolidated to
 * one shared computation (see useSuggestions.tsx).
 */
import { normalize } from '../math/normalize';
import { evaluate } from '../math/evaluate';
import type { GroupId, Sizes } from '../math/expr';
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

export function curvesForVectors(
  ast: Expr,
  vectors: Array<Record<GroupId, number>>,
  deckSize: number,
  baseSizes: Sizes,
): SuggestionCurve[] {
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
