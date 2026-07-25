import { lnC } from './lnfact';

export interface HyperParams {
  /** deck size */ N: number;
  /** successes in deck */ K: number;
  /** cards drawn */ n: number;
}

function assertParams(N: number, K: number, n: number): void {
  if (!Number.isInteger(N) || N < 0) throw new RangeError(`N=${N}`);
  if (!Number.isInteger(K) || K < 0 || K > N) throw new RangeError(`K=${K} (N=${N})`);
  if (!Number.isInteger(n) || n < 0 || n > N) throw new RangeError(`n=${n} (N=${N})`);
}

/** Inclusive support of X: [lo, hi]. */
export function support(N: number, K: number, n: number): [number, number] {
  assertParams(N, K, n);
  return [Math.max(0, n - (N - K)), Math.min(n, K)];
}

/** P(X = x) */
export function pmf(N: number, K: number, n: number, x: number): number {
  const [lo, hi] = support(N, K, n);
  if (x < lo || x > hi) return 0;
  return Math.exp(lnC(K, x) + lnC(N - K, n - x) - lnC(N, n));
}

/** P(X <= x) */
export function cdf(N: number, K: number, n: number, x: number): number {
  const [lo, hi] = support(N, K, n);
  if (x < lo) return 0;
  if (x >= hi) return 1;
  let s = 0;
  for (let i = lo; i <= x; i++) s += pmf(N, K, n, i);
  return Math.min(1, s);
}

/** P(X >= k) — the workhorse query. */
export function sfAtLeast(N: number, K: number, n: number, k: number): number {
  const [lo, hi] = support(N, K, n);
  if (k <= lo) return 1;
  if (k > hi) return 0;
  // Sum the shorter tail to limit accumulated error.
  if (k - lo < hi - k) return 1 - cdf(N, K, n, k - 1);
  let s = 0;
  for (let i = k; i <= hi; i++) s += pmf(N, K, n, i);
  return Math.min(1, s);
}

/** P(lo <= X <= hi) */
export function between(N: number, K: number, n: number, lo: number, hi: number): number {
  if (lo > hi) return 0;
  return Math.max(0, sfAtLeast(N, K, n, lo) - sfAtLeast(N, K, n, hi + 1));
}
