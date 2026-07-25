/**
 * Exact BigInt oracle. TESTS ONLY — never import from app code.
 * Existence justified in PLAN.md §9: the float paths fail silently, so they need a ground truth.
 */
export function binomBig(n: number, k: number): bigint {
  if (k < 0 || k > n || n < 0) return 0n;
  const kk = Math.min(k, n - k);
  let r = 1n;
  for (let i = 0; i < kk; i++) {
    r = (r * BigInt(n - i)) / BigInt(i + 1);
  }
  return r;
}

/** Exact P(X >= k) as a float, via BigInt rationals. */
export function sfAtLeastExact(N: number, K: number, n: number, k: number): number {
  const total = binomBig(N, n);
  if (total === 0n) return 0;
  let num = 0n;
  for (let x = Math.max(k, 0); x <= Math.min(n, K); x++) {
    num += binomBig(K, x) * binomBig(N - K, n - x);
  }
  return ratioToNumber(num, total);
}

/** Divide two bigints without overflowing float64 on the way. */
export function ratioToNumber(num: bigint, den: bigint): number {
  if (den === 0n) throw new Error('ratioToNumber: zero denominator');
  const SCALE = 10n ** 25n;
  return Number((num * SCALE) / den) / Number(SCALE);
}
