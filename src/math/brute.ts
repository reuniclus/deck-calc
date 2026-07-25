/**
 * Brute-force reference by full enumeration of draws. TESTS ONLY.
 * Independent of every DP/inclusion-exclusion code path on purpose — this is
 * what catches sign errors in the boolean layer (PLAN.md §9).
 * Exponential in N. Keep N <= 22.
 */
import { binom } from './lnfact';

export function bruteCurve(
  N: number,
  groupSizes: readonly number[],
  satisfies: (counts: readonly number[]) => boolean,
): Float64Array {
  if (N > 22) throw new RangeError('bruteCurve: N too large');
  const total = groupSizes.reduce((a, b) => a + b, 0);
  if (total > N) throw new RangeError('groups exceed deck');

  // card index -> group index, or -1 for the unconstrained remainder
  const owner = new Int8Array(N).fill(-1);
  let at = 0;
  groupSizes.forEach((size, g) => {
    for (let i = 0; i < size; i++) owner[at++] = g;
  });

  const hits = new Float64Array(N + 1);
  const counts = new Array<number>(groupSizes.length);

  for (let mask = 0; mask < 1 << N; mask++) {
    counts.fill(0);
    let drawn = 0;
    for (let i = 0; i < N; i++) {
      if ((mask >> i) & 1) {
        drawn++;
        const g = owner[i]!;
        if (g >= 0) counts[g]!++;
      }
    }
    if (satisfies(counts)) hits[drawn]!++;
  }

  const out = new Float64Array(N + 1);
  for (let n = 0; n <= N; n++) out[n] = hits[n]! / binom(N, n);
  return out;
}
