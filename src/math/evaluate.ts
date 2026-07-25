import { boxCurve, type Constraint, type Curve } from './boxdp';
import { type Box, type Dnf, type Sizes, QueryTooLargeError, boxKey, intersect } from './expr';

/** Above this, inclusion-exclusion runs 2^c DP passes and stops being free. */
export const MAX_IE_CLAUSES = 12;

export interface EvalResult {
  curve: Curve;
  /** clauses in the pruned DNF */
  clauses: number;
  /** inclusion-exclusion terms that survived pruning and were actually evaluated */
  terms: number;
  monotone: boolean;
}

/**
 * P(union of boxes) for every draw count, by inclusion-exclusion over clause subsets.
 * Every term is a single box, so every term is one existing DP call. PLAN.md §3.4.
 */
export function evaluate(N: number, sizes: Sizes, dnf: Dnf): EvalResult {
  const { clauses, monotone } = dnf;
  const base = { clauses: clauses.length, monotone };

  if (clauses.length === 0) return { ...base, curve: new Float64Array(N + 1), terms: 0 };
  if (clauses.some((b) => Object.keys(b).length === 0)) {
    return { ...base, curve: new Float64Array(N + 1).fill(1), terms: 0 };
  }
  if (clauses.length > MAX_IE_CLAUSES) {
    throw new QueryTooLargeError(
      `${clauses.length} clauses needs 2^${clauses.length} terms; cap is ${MAX_IE_CLAUSES}`);
  }

  const acc = new Float64Array(N + 1);
  const comp = new Float64Array(N + 1); // Kahan compensation — the terms alternate sign
  const cache = new Map<string, Curve>();
  let terms = 0;

  for (let mask = 1; mask < 1 << clauses.length; mask++) {
    let merged: Box | null = {};
    let bits = 0;
    for (let i = 0; i < clauses.length && merged; i++) {
      if ((mask >> i) & 1) { bits++; merged = intersect(merged, clauses[i]!); }
    }
    if (!merged) continue; // empty intersection contributes nothing
    terms++;

    const key = boxKey(merged);
    let curve = cache.get(key);
    if (!curve) {
      curve = boxCurve(N, toConstraints(merged, sizes));
      cache.set(key, curve);
    }

    const sign = bits % 2 === 1 ? 1 : -1;
    for (let n = 0; n <= N; n++) {
      const y = sign * curve[n]! - comp[n]!;
      const t = acc[n]! + y;
      comp[n] = t - acc[n]! - y;
      acc[n] = t;
    }
  }

  for (let n = 0; n <= N; n++) {
    const p = acc[n]!;
    // Outside this band it is a bug in normalization, not rounding. PLAN.md §3.6.
    if (p < -1e-9 || p > 1 + 1e-9) throw new Error(`evaluate: P=${p} out of range at n=${n}`);
    acc[n] = p < 0 ? 0 : p > 1 ? 1 : p;
  }
  return { ...base, curve: acc, terms };
}

function toConstraints(box: Box, sizes: Sizes): Constraint[] {
  return Object.keys(box).map((g) => {
    const K = sizes[g];
    if (K === undefined) throw new Error(`unknown group "${g}"`);
    return { K, lo: box[g]!.lo, hi: box[g]!.hi };
  });
}
