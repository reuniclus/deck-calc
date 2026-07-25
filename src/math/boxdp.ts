import { binom } from './lnfact';

/**
 * One constrained group: K copies in the deck, event requires lo <= X <= hi.
 * See PLAN.md §3.3.
 */
export interface Constraint {
  K: number;
  lo: number;
  hi: number;
}

/** P(event) indexed by cards drawn: curve[n] for n = 0..N. */
export type Curve = Float64Array;

export const MAX_DECK = 1024;

/**
 * Exact P(lo_g <= X_g <= hi_g for all g) for EVERY draw count in one pass.
 *
 * The DP counts ways to take s cards from the constrained groups; it does not
 * involve n at all. Only the final convolution against the unconstrained pool
 * depends on n, so the whole curve costs one DP. This is the load-bearing
 * property behind the curve view, the draws-needed scan and the grid views.
 */
export function boxCurve(N: number, constraints: readonly Constraint[]): Curve {
  if (!Number.isInteger(N) || N < 0 || N > MAX_DECK) throw new RangeError(`N=${N}`);

  const out = new Float64Array(N + 1);

  let kSum = 0;
  for (const c of constraints) {
    if (!Number.isInteger(c.K) || c.K < 0) throw new RangeError(`K=${c.K}`);
    kSum += c.K;
  }
  const R = N - kSum;
  if (R < 0) throw new RangeError(`constrained groups (${kSum}) exceed deck (${N})`);

  // ways[s] = number of ways to choose s cards from the constrained groups
  // while satisfying every interval. Raw counts, held in float64.
  let ways = new Float64Array(1);
  ways[0] = 1;
  let sMax = 0;

  for (const c of constraints) {
    const lo = Math.max(0, c.lo);
    const hi = Math.min(c.hi, c.K);
    if (lo > hi) return out; // empty box — impossible at every n
    const next = new Float64Array(sMax + hi + 1);
    for (let s = 0; s <= sMax; s++) {
      const w = ways[s]!;
      if (w === 0) continue;
      for (let x = lo; x <= hi; x++) next[s + x]! += w * binom(c.K, x);
    }
    ways = next;
    sMax += hi;
  }

  for (let n = 0; n <= N; n++) {
    const denom = binom(N, n);
    let acc = 0;
    const from = Math.max(0, n - R);
    const to = Math.min(sMax, n);
    for (let s = from; s <= to; s++) {
      const w = ways[s]!;
      if (w !== 0) acc += w * binom(R, n - s);
    }
    const p = acc / denom;
    if (!Number.isFinite(p)) throw new Error(`boxCurve overflow at N=${N}, n=${n}`);
    out[n] = p < 0 ? 0 : p > 1 ? 1 : p;
  }
  return out;
}
