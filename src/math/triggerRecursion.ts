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
import { cheapTail } from './cheapTail';
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


export interface RecursionBound { lo: number; hi?: number }

/**
 * The same per-trigger recursion generalised to several tracked groups, upper
 * bounds, and an OR of clauses.
 *
 * Bricks needed no query editing, unlike the closed-form method: this tracks what
 * is in hand, so a bottomed brick simply never enters `acq`, and the greedy keep
 * rule refuses it automatically because a brick is never "needed".
 *
 * Two things did have to change:
 *  - **success stops absorbing** unless the satisfied clause is UNBREAKABLE (no
 *    upper bound it could later violate). With a bound you can be satisfied on
 *    one draw and busted on the next, so the branch must run to the horizon.
 *  - **a clause dies permanently** once one of its bounds is exceeded, since
 *    counts only rise; when every clause is dead the branch is worth nothing.
 *
 * The keep rule is still GREEDY -- take what the most demanding live clause still
 * wants -- which is provably optimal for a single monotone clause but only a
 * heuristic across clauses, where keeping toward one clause spends draws another
 * wanted. Whether that costs accuracy is a measurement, not an assumption.
 */
export function triggerRecursionDnf(
  deck: number,
  counts: number[],
  clauses: RecursionBound[][],
  copies: number,
  look: number,
  draws: number,
): { p: number; calls: number } {
  const G = counts.length;
  const C = clauses.length;
  const lo = clauses.map((cl) => counts.map((_, g) => cl[g]?.lo ?? 0));
  const hi = clauses.map((_cl, ci) => counts.map((n, g) => clauses[ci]![g]?.hi ?? n));
  const unbreakable = clauses.map((_, ci) => counts.every((n, g) => hi[ci]![g]! >= n));
  const caps = counts.map((n, g) => Math.min(n, Math.max(
    ...clauses.map((_, ci) => (hi[ci]![g]! >= n ? lo[ci]![g]! : Math.min(n, hi[ci]![g]! + 1))),
  )));
  /** A group that no live clause tolerates at all (`hi = 0` everywhere it is
   * bounded) can only ever be zero in a surviving path. Enumerating fresh-draw
   * branches that contain one is pure waste -- they contribute exactly zero -- so
   * those branches are skipped rather than computed and discarded. Free: no
   * accuracy change, strictly less enumeration. This is the brick handled as a
   * CONSTRAINT on the enumeration rather than as tracked state. */
  const forbidden = counts.map((_, g) => clauses.every((_cl, ci) => hi[ci]![g]! === 0));
  const ids = counts.map((_, i) => `g${i}`);
  const dnf: Dnf = {
    clauses: clauses.map((cl) => {
      const box: Record<string, { lo: number; hi: number }> = {};
      cl.forEach((b, g) => { box[ids[g]!] = { lo: b?.lo ?? 0, hi: b?.hi ?? counts[g]! }; });
      return box;
    }),
    monotone: false,
  };

  let calls = 0;
  const memo = new Map<string, number>();
  const tailMemo = new Map<string, number>();
  /** Exactly one group carries an upper bound -- the brick case, where the cheap
   * tail applies. */
  const boundedGroups = counts.map((n, g) => (hi[0]![g]! >= n ? -1 : g)).filter((g) => g >= 0);

  /**
   * Absorbing success for a bounded clause. Once every `lo` is met nothing is
   * wanted, so no keep can happen again, and the remaining question -- surviving
   * the upper bound -- is exactly what `cheapTail` computes in closed form.
   *
   * Two earlier attempts handed this to the GENERAL closed-form pass, which costs
   * seconds per call and made the whole thing slower than recursing. The tail is a
   * degenerate case: no keeps means no window-composition enumeration is needed.
   */
  const tail = (rem: number[], remC: number, remO: number, acq: number[], d: number): number => {
    const g = boundedGroups[0]!;
    const residual = hi[0]![g]! - acq[g]!;
    if (residual < 0) return 0;
    const key = `${rem.join(',')}|${remC}|${remO}|${residual}|${d}`;
    const hit = tailMemo.get(key);
    if (hit !== undefined) return hit;
    const pool = rem.reduce((a, r) => a + r, 0) + remC + remO;
    const v = cheapTail(pool, rem[g]!, residual, remC, look, d);
    tailMemo.set(key, v);
    return v;
  };

  const met = (acq: number[], ci: number): boolean =>
    counts.every((_, g) => acq[g]! >= lo[ci]![g]! && acq[g]! <= hi[ci]![g]!);
  const alive = (acq: number[], ci: number): boolean =>
    counts.every((_, g) => acq[g]! <= hi[ci]![g]!);

  function V(rem: number[], remC: number, remO: number, acq: number[], d: number): number {
    let anyMet = false;
    let anyAlive = false;
    for (let ci = 0; ci < C; ci++) {
      if (met(acq, ci)) {
        anyMet = true;
        if (unbreakable[ci]!) return 1;
      }
      if (alive(acq, ci)) anyAlive = true;
    }
    if (!anyAlive) return 0;
    if (d <= 0) return anyMet ? 1 : 0;
    if (C === 1 && boundedGroups.length === 1 && !unbreakable[0]!
      && counts.every((_, g) => acq[g]! >= lo[0]![g]!)) {
      return tail(rem, remC, remO, acq, d);
    }
    const pool = rem.reduce((a, r) => a + r, 0) + remC + remO;
    if (pool <= 0) return anyMet ? 1 : 0;

    const key = `${rem.join(',')}|${remC}|${remO}|${acq.join(',')}|${d}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    calls++;

    const sizesOf = (r: number[]): Record<string, number> => {
      const out: Record<string, number> = {};
      r.forEach((v, g) => { out[ids[g]!] = v; });
      return out;
    };
    const securedOf = (a: number[]): Record<string, number> => {
      const out: Record<string, number> = {};
      a.forEach((v, g) => { out[ids[g]!] = v; });
      return out;
    };

    const nonCopy = pool - remC;
    // branch A: no copy among the remaining draws
    let pNoCopy = 1;
    for (let i = 0; i < Math.min(d, pool); i++) pNoCopy *= (nonCopy - i) / (pool - i);
    let total = 0;
    if (pNoCopy > 0) {
      const curve = evaluate(nonCopy, sizesOf(rem), shiftDnf(dnf, securedOf(acq))).curve;
      total += pNoCopy * (curve[Math.min(d, curve.length - 1)] ?? 0);
    }

    // branch B: the next copy arrives after g fresh non-copy cards
    for (let g = 0; g <= d - 1 && g <= nonCopy; g++) {
      let pg = 1;
      for (let i = 0; i < g; i++) pg *= (nonCopy - i) / (pool - i);
      pg *= remC / (pool - g);
      if (pg <= 0) continue;
      const freshComp: number[] = new Array(G).fill(0) as number[];
      const denomFresh = comb(nonCopy, g);
      const walkFresh = (gi: number, left: number, ways: number): void => {
        if (gi === G) {
          if (left < 0 || left > remO) return;
          const pComp = (ways * comb(remO, left)) / denomFresh;
          if (pComp <= 0) return;
          const acq1 = acq.map((a, i) => Math.min(caps[i]!, a + freshComp[i]!));
          const rem1 = rem.map((r, i) => r - freshComp[i]!);
          const remO1 = remO - left;
          const remC1 = remC - 1;
          const d1 = d - g - 1;
          const pool1 = rem1.reduce((a, r) => a + r, 0) + remC1 + remO1;
          const w = Math.min(look, pool1);
          if (w <= 0 || d1 <= 0) {
            total += pg * pComp * V(rem1, remC1, remO1, acq1, d1);
            return;
          }
          // enumerate the window, keep greedily toward the most demanding live clause
          const denomW = comb(pool1, w);
          const wComp: number[] = new Array(G).fill(0) as number[];
          const walkWin = (wi: number, leftW: number, waysW: number): void => {
            if (wi === G) {
              for (let wc = 0; wc <= Math.min(remC1, leftW); wc++) {
                const wo = leftW - wc;
                if (wo < 0 || wo > remO1) continue;
                const pw = (waysW * comb(remC1, wc) * comb(remO1, wo)) / denomW;
                if (pw <= 0) continue;
                let spent = 0;
                const acq2 = [...acq1];
                for (let i = 0; i < G; i++) {
                  let want = 0;
                  for (let ci = 0; ci < C; ci++) {
                    if (!alive(acq1, ci)) continue;
                    want = Math.max(want, lo[ci]![i]! - acq1[i]!);
                  }
                  const take = Math.min(wComp[i]!, Math.max(0, want), Math.max(0, d1 - spent));
                  acq2[i] = Math.min(caps[i]!, acq2[i]! + take);
                  spent += take;
                }
                const rem2 = rem1.map((r, i) => r - wComp[i]!);
                total += pg * pComp * pw
                  * V(rem2, remC1 - wc, remO1 - wo, acq2, d1 - spent);
              }
              return;
            }
            const maxTake = Math.min(rem1[wi]!, leftW);
            for (let t = 0; t <= maxTake; t++) {
              wComp[wi] = t;
              walkWin(wi + 1, leftW - t, waysW * comb(rem1[wi]!, t));
            }
            wComp[wi] = 0;
          };
          walkWin(0, w, 1);
          return;
        }
        // A forbidden group drawn into hand kills every clause, so only the
        // zero branch can survive.
        const maxTake = forbidden[gi] ? 0 : Math.min(rem[gi]!, left);
        for (let t = 0; t <= maxTake; t++) {
          freshComp[gi] = t;
          walkFresh(gi + 1, left - t, ways * comb(rem[gi]!, t));
        }
        freshComp[gi] = 0;
      };
      walkFresh(0, g, 1);
    }
    memo.set(key, total);
    return total;
  }

  const others = deck - counts.reduce((a, c) => a + c, 0) - copies;
  return { p: V([...counts], copies, others, new Array(G).fill(0) as number[], draws), calls };
}
