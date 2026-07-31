/**
 * Cheap exact tail for a PURE UPPER BOUND query with zero keeps -- the state a
 * bounded query reaches once every lower bound is satisfied and nothing more is
 * wanted.
 *
 * Why it is cheap: with no keeps, no draw is ever spent collecting, so the process
 * is exactly DRAW-SHAPED and `slotDistribution` (cached, query-independent)
 * applies unchanged. Window CONTENTS are irrelevant -- only that a window consumed
 * cards -- so there is no composition enumeration, which is the expensive part of
 * the general closed-form pass. What remains per slot outcome: the chance that at
 * most `cap` of the bricks in the seen prefix landed in a SCHEDULED position (into
 * hand, counting against the bound) rather than a WINDOW position (bottomed,
 * harmless). A positional hypergeometric.
 *
 * Verified exact against the DP on six configurations, at 4-22ms against 38-100ms.
 * The general pass costs seconds for the same answer, which is why two earlier
 * attempts to reuse it as a tail were unusable.
 *
 * Handles ONE bounded group, which is the brick case. Several bounded groups need
 * the positional split generalised to a multivariate form.
 */
import { slotDistribution } from './selection';
import { pmf } from './hyper';

export function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

/**
 * Cheap tail: a PURE UPPER BOUND query with zero keeps.
 *
 * Nothing is ever kept, so no draw is spent collecting, so the process is exactly
 * DRAW-SHAPED and the cached slot distribution applies unchanged. Window contents
 * are irrelevant -- only that a window consumed cards -- so there is no
 * composition enumeration at all. What remains: per slot outcome, the chance that
 * at most `cap` of the bricks in the seen prefix landed in a SCHEDULED position
 * (into hand, counting against the bound) rather than a WINDOW position (bottomed,
 * harmless). Positional hypergeometric.
 */
export function cheapTail(pool: number, bricks: number, cap: number, copies: number, look: number, draws: number): number {
  const nonCopyPool = pool - copies;
  let total = 0;
  for (const { seen, copies: cC, p } of slotDistribution(pool, copies, look, draws)[draws]!) {
    if (p <= 0) continue;
    const triggers = look > 0 ? Math.round((seen - draws) / look) : 0;
    const seenNonCopy = seen - cC;
    const schedNonCopy = draws - triggers;               // hand positions
    const windowNonCopy = seenNonCopy - schedNonCopy;    // bottomed positions
    if (schedNonCopy < 0 || windowNonCopy < 0) continue;
    let acc = 0;
    for (let b = 0; b <= Math.min(bricks, seenNonCopy); b++) {
      const pb = pmf(nonCopyPool, bricks, seenNonCopy, b);
      if (pb <= 0) continue;
      // how many of those b bricks landed in a scheduled (hand) position
      let ok = 0;
      for (let j = 0; j <= Math.min(cap, b); j++) {
        ok += (comb(schedNonCopy, j) * comb(windowNonCopy, b - j)) / comb(seenNonCopy, b);
      }
      acc += pb * ok;
    }
    total += p * acc;
  }
  return total;
}

