/**
 * Per-trigger recursion: the scry model expressed natively in hypergeometric
 * terms, with no borrowed draw-shaped slot machinery and no correction factors.
 *
 * The idea (raised 2026-07-30): a trigger requires the cantrip IN HAND, which is
 * `hold = seen - ditched` applied to the cantrip group itself. So each step finds
 * the next cantrip within the remaining draws, resolves its window, spends the
 * kept cards' draws, removes the window from the pool, and recurses. Position is
 * never enumerated -- each step consumes a known budget before the next search --
 * which is what makes `precedingKeeps` and `firstTriggerPosition` unnecessary
 * rather than merely better.
 *
 * Two branches per step:
 *  - no cantrip among the remaining draws: those draws are a sample of the
 *    NON-COPY pool, so the query is settled by ordinary hypergeometry;
 *  - the next cantrip arrives after `g` fresh cards (negative hypergeometric),
 *    whose composition is enumerated, then its window resolves.
 *
 * MEASURED: exact to floating point against `exactSelectionCurveDnf`, and 2-5x
 * FASTER than it (69ms vs 143ms, 6ms vs 31ms, 43ms vs 126ms), using 32-792 states.
 * It is faster despite tracking sequence because it jumps the gap of fresh draws
 * in one hypergeometric step rather than one card at a time, so there are far
 * fewer levels to memoise. The closed-form method it replaces was +0.9 to +1.5pt
 * out on the same configurations.
 *
 * SCOPE: single tracked group, monotone (`>=`) query, one effect type. Greedy keep
 * is provably optimal there, which is why no max over decisions is needed. Upper
 * bounds and OR clauses need that max and are NOT handled here.
 */
import { evaluate } from './evaluate';
import { shiftDnf } from './reveal';
import type { Dnf } from './expr';

export function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

/**
 * Trigger layer as a per-trigger recursion, single tracked group, monotone.
 * Each step: find the next cantrip within the remaining draws (negative
 * hypergeometric), resolve its window, spend `kept` draws, remove the window
 * from the pool, recurse. Position is never enumerated -- each step consumes a
 * known budget before the next search.
 */
export function triggerRecursion(
  deck: number, A: number, need: number, copies: number, look: number, draws: number,
): { p: number; calls: number } {
  const dnf: Dnf = { clauses: [{ A: { lo: need, hi: A } }], monotone: true };
  let calls = 0;
  const memo = new Map<string, number>();

  // remA: group cards left in pool; remC: copies left; remO: filler left;
  // acq: group cards already secured (capped at need); d: draws left
  function V(remA: number, remC: number, remO: number, acq: number, d: number): number {
    if (acq >= need) return 1;
    if (d <= 0) return 0;
    const pool = remA + remC + remO;
    if (pool <= 0) return 0;
    const key = `${remA}|${remC}|${remO}|${acq}|${d}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    calls++;

    const nonCopy = remA + remO;
    // branch A: no copy among the remaining d draws -> they are a sample of the
    // non-copy pool, and the query is settled by ordinary hypergeometry
    let pNoCopy = 1;
    for (let i = 0; i < Math.min(d, pool); i++) pNoCopy *= (nonCopy - i) / (pool - i);
    let total = 0;
    if (pNoCopy > 0) {
      const curve = evaluate(nonCopy, { A: remA }, shiftDnf(dnf, { A: acq })).curve;
      total += pNoCopy * (curve[Math.min(d, curve.length - 1)] ?? 0);
    }

    // branch B: first copy after g non-copy cards, g = 0..d-1
    for (let g = 0; g <= d - 1 && g <= nonCopy; g++) {
      // P(g non-copy then a copy)
      let pg = 1;
      for (let i = 0; i < g; i++) pg *= (nonCopy - i) / (pool - i);
      pg *= remC / (pool - g);
      if (pg <= 0) continue;
      // composition of those g fresh cards
      for (let a = 0; a <= Math.min(g, remA); a++) {
        const o = g - a;
        if (o < 0 || o > remO) continue;
        const pComp = (comb(remA, a) * comb(remO, o)) / comb(nonCopy, g);
        if (pComp <= 0) continue;
        const acq1 = Math.min(need, acq + a);
        if (acq1 >= need) { total += pg * pComp; continue; }
        const remA1 = remA - a, remO1 = remO - o, remC1 = remC - 1;
        const pool1 = remA1 + remC1 + remO1;
        const d1 = d - g - 1;
        const w = Math.min(look, pool1);
        if (w <= 0 || d1 <= 0) { total += pg * pComp * V(remA1, remC1, remO1, acq1, d1); continue; }
        const denom = comb(pool1, w);
        for (let wa = 0; wa <= Math.min(remA1, w); wa++) {
          for (let wc = 0; wc <= Math.min(remC1, w - wa); wc++) {
            const wo = w - wa - wc;
            if (wo < 0 || wo > remO1) continue;
            const pw = (comb(remA1, wa) * comb(remC1, wc) * comb(remO1, wo)) / denom;
            if (pw <= 0) continue;
            const take = Math.min(wa, need - acq1, d1);   // keeps cost draws
            total += pg * pComp * pw
              * V(remA1 - wa, remC1 - wc, remO1 - wo, Math.min(need, acq1 + take), d1 - take);
          }
        }
      }
    }
    memo.set(key, total);
    return total;
  }

  const others = deck - A - copies;
  return { p: V(A, copies, others, 0, draws), calls };
}

