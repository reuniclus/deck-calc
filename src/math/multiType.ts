/**
 * Multi-type selection DP: several DIFFERENT effects in one deck (Preordain and
 * Ponder and Brainstorm together), each with its own look size, keep cap and
 * bottoming behaviour.
 *
 * Why this is a straightforward generalisation rather than a new design: the DNF
 * engine resolves a window ATOMICALLY at the moment its copy is drawn, so no window
 * credits persist between transitions. The state therefore needs only `remC` widened
 * from a scalar to a vector -- one count per type -- and each window resolved with
 * its own type's parameters. The shared-pool-versus-per-type-credits decision that
 * would matter for a credit-based engine simply does not arise here.
 *
 * Cost: state grows with the product of per-type remaining counts, so 3 types x 4
 * copies is ~125 `remC` states against 13 for a single 12-copy type.
 *
 * Scope: draw / impulse / scry shapes (via `keptCostsDraw` and `nonKeptLeavesPool`).
 * Ponder's shuffle branch is not modelled here.
 *
 * **STATUS: RESEARCH, NOT VERIFIED.** Written in one pass and only partly tested.
 * What is established:
 *  - SPLIT INVARIANCE passes -- declaring one effect as several types with identical
 *    parameters does not change the answer (to 10 decimals, monotone and bounded).
 *  - It agrees with `exactSelectionCurveDnf` exactly on MONOTONE scry queries.
 *  - It is GROUPING-INVARIANT where the shipped DP is not: on the 10-card arbitration
 *    config it returns 0.417142857 for both the OR and merged spellings, while the
 *    shipped DP splits 0.404761905 / 0.380634921. Its value is higher than both and
 *    still under the clairvoyant ceiling of 0.470687831, which is the signature of a
 *    better policy search rather than an error.
 *
 * What is NOT established:
 *  - Optimality. Higher-and-invariant is consistent with being correct, but the
 *    clairvoyant bound is loose, so the truth lies somewhere in 0.4171..0.4707.
 *  - The draw and impulse agreement tests currently FAIL against the single-type DP.
 *    Those may be the same phenomenon (this engine finding better play) or genuine
 *    bugs; nobody has looked.
 *
 * So: do not ship, and do not treat as a reference. But it is the strongest evidence
 * yet that the shipped DP's sub-optimality under scry-plus-bounds is a fixable
 * implementation detail rather than something inherent -- and being independent, this
 * engine can serve as the arbiter while that is fixed.
 */
import type { Curve } from './boxdp';

export interface MultiEffectType {
  /** Copies of this effect in the deck. */
  count: number;
  /** Cards examined per cast. */
  examined: number;
  /** Cards keepable per window; `Infinity` for uncapped. */
  keepMax: number;
  /** Does collecting a kept card cost a draw (scry) or is it free (draw/impulse)? */
  keptCostsDraw: boolean;
  /** Do non-kept cards leave the pool (bottomed) or stay on top? */
  nonKeptLeavesPool: boolean;
}

export interface MultiBound { lo: number; hi?: number }

function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

export function exactSelectionCurveMulti(
  deckSize: number,
  counts: number[],
  clauses: MultiBound[][],
  types: MultiEffectType[],
  maxDraws: number,
): Curve {
  const G = counts.length;
  const T = types.length;
  const lo = clauses.map((cl) => counts.map((_, g) => cl[g]?.lo ?? 0));
  const hi = clauses.map((_cl, ci) => counts.map((n, g) => clauses[ci]![g]?.hi ?? n));
  const caps = counts.map((n, g) => Math.min(n, Math.max(
    ...clauses.map((_c, ci) => (hi[ci]![g]! >= n ? lo[ci]![g]! : Math.min(n, hi[ci]![g]! + 1))),
  )));
  const unbreakable = clauses.map((_c, ci) => counts.every((n, g) => hi[ci]![g]! >= n));
  const totalCopies = types.reduce((a, t) => a + t.count, 0);
  const others = deckSize - counts.reduce((a, c) => a + c, 0) - totalCopies;
  if (others < 0) throw new Error('group counts plus effect copies exceed the deck');

  const met = (acq: number[], ci: number): boolean =>
    counts.every((_v, g) => acq[g]! >= lo[ci]![g]! && acq[g]! <= hi[ci]![g]!);
  const alive = (acq: number[], ci: number): boolean =>
    counts.every((_v, g) => acq[g]! <= hi[ci]![g]!);

  const memo = new Map<string, number>();

  function V(rem: number[], remC: number[], remO: number, acq: number[], d: number): number {
    let anyMet = false;
    let anyAlive = false;
    for (let ci = 0; ci < clauses.length; ci++) {
      if (met(acq, ci)) {
        anyMet = true;
        if (unbreakable[ci]!) return 1;
      }
      if (alive(acq, ci)) anyAlive = true;
    }
    if (!anyAlive) return 0;
    if (d <= 0) return anyMet ? 1 : 0;
    const pool = rem.reduce((a, r) => a + r, 0) + remC.reduce((a, c) => a + c, 0) + remO;
    if (pool <= 0) return anyMet ? 1 : 0;

    const key = `${rem.join(',')}|${remC.join(',')}|${remO}|${acq.join(',')}|${d}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;

    let total = 0;
    // filler
    if (remO > 0) total += (remO / pool) * V(rem, remC, remO - 1, acq, d - 1);
    // a tracked card
    for (let g = 0; g < G; g++) {
      if (rem[g]! <= 0) continue;
      const rem2 = [...rem]; rem2[g] = rem2[g]! - 1;
      const acq2 = [...acq]; acq2[g] = Math.min(caps[g]!, acq2[g]! + 1);
      total += (rem[g]! / pool) * V(rem2, remC, remO, acq2, d - 1);
    }
    // a copy of each type: resolve its window atomically with ITS parameters
    for (let t = 0; t < T; t++) {
      if (remC[t]! <= 0) continue;
      const pCard = remC[t]! / pool;
      const remC1 = [...remC]; remC1[t] = remC1[t]! - 1;
      const ty = types[t]!;
      const poolAfter = pool - 1;
      const w = Math.min(ty.examined, poolAfter);
      const d1 = d - 1;
      if (w <= 0 || d1 <= 0) {
        total += pCard * V(rem, remC1, remO, acq, d1);
        continue;
      }
      const denom = comb(poolAfter, w);
      const wg: number[] = new Array(G).fill(0) as number[];
      const wc: number[] = new Array(T).fill(0) as number[];
      // enumerate the window's composition over groups, then types, then filler
      const walkTypes = (ti: number, left: number, ways: number): void => {
        if (ti === T) {
          const wo = left;
          if (wo < 0 || wo > remO) return;
          const pw = (ways * comb(remO, wo)) / denom;
          if (pw <= 0) return;
          // maximise over keep vectors, respecting this type's cap and draw cost
          const budget = Math.min(ty.keepMax, w, ty.keptCostsDraw ? d1 : w);
          let best = -1;
          const take: number[] = new Array(G).fill(0) as number[];
          const pick = (g: number, left2: number, spent: number): void => {
            if (g === G) {
              const acq2 = acq.map((a, i) => Math.min(caps[i]!, a + take[i]!));
              // kept cards always leave the pool; non-kept leave only if bottomed
              const rem2 = rem.map((r, i) => r - (ty.nonKeptLeavesPool ? wg[i]! : take[i]!));
              const remC2 = ty.nonKeptLeavesPool
                ? remC1.map((c, i) => c - wc[i]!)
                : [...remC1];
              const remO2 = ty.nonKeptLeavesPool ? remO - wo : remO;
              const dAfter = ty.keptCostsDraw ? d1 - spent : d1;
              best = Math.max(best, V(rem2, remC2, remO2, acq2, dAfter));
              return;
            }
            const maxTake = Math.min(wg[g]!, left2);
            for (let k = 0; k <= maxTake; k++) {
              take[g] = k;
              pick(g + 1, left2 - k, spent + k);
            }
            take[g] = 0;
          };
          pick(0, budget, 0);
          total += pCard * pw * best;
          return;
        }
        const maxTake = Math.min(remC1[ti]!, left);
        for (let k = 0; k <= maxTake; k++) {
          wc[ti] = k;
          walkTypes(ti + 1, left - k, ways * comb(remC1[ti]!, k));
        }
        wc[ti] = 0;
      };
      const walkGroups = (g: number, left: number, ways: number): void => {
        if (g === G) { walkTypes(0, left, ways); return; }
        const maxTake = Math.min(rem[g]!, left);
        for (let k = 0; k <= maxTake; k++) {
          wg[g] = k;
          walkGroups(g + 1, left - k, ways * comb(rem[g]!, k));
        }
        wg[g] = 0;
      };
      walkGroups(0, w, 1);
    }
    memo.set(key, total);
    return total;
  }

  const out = new Float64Array(maxDraws + 1);
  const startRem = [...counts];
  const startC = types.map((t) => t.count);
  for (let n = 0; n <= maxDraws; n++) {
    out[n] = V(startRem, startC, others, new Array(G).fill(0) as number[], n);
  }
  // a query demanding nothing is satisfied at zero draws
  if (clauses.some((cl) => counts.every((_v, g) => (cl[g]?.lo ?? 0) === 0))) out[0] = Math.max(out[0]!, 1);
  return out;
}
