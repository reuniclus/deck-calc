import { it } from 'vitest';
import { evaluate } from './evaluate';
import { shiftDnf } from './reveal';
import { slotDistribution, exactSelectionCurveDnf } from './selection';
import type { Dnf, GroupId } from './expr';

function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

/** the ORIGINAL method from the error table: draw-shaped slot distribution,
 *  fixed keep rule, bottomed cards removed from the pool. */
function method(
  N: number, counts: number[], clauses: Array<Array<{ lo: number; hi?: number }>>,
  copies: number, S: number, n: number,
): { p: number; expKeeps: number } {
  const G = counts.length;
  const ids: GroupId[] = counts.map((_, i) => `g${i}`);
  const pool = N - copies;
  const fillerPool = pool - counts.reduce((a, c) => a + c, 0);
  const dnf: Dnf = {
    clauses: clauses.map((cl) => {
      const box: Record<GroupId, { lo: number; hi: number }> = {};
      cl.forEach((b, i) => { box[ids[i]!] = { lo: b.lo, hi: b.hi ?? counts[i]! }; });
      return box;
    }),
    monotone: false,
  };
  const maxLo = counts.map((_, gi) => Math.max(...clauses.map((cl) => cl[gi]?.lo ?? 0)));
  let total = 0;
  let expKeeps = 0;
  for (const { seen, copies: cC, p } of slotDistribution(N, copies, S, n)[n]!) {
    if (p <= 0) continue;
    const t = Math.round((seen - n) / S);
    const sched = n - t;
    const Wn = t * S - (cC - t);
    if (t === 0 || Wn <= 0) {
      const c0 = evaluate(pool, Object.fromEntries(ids.map((id, i) => [id, counts[i]!])), dnf).curve;
      total += p * (c0[Math.min(Math.max(0, sched), c0.length - 1)] ?? 0);
      continue;
    }
    const w: number[] = new Array(G).fill(0) as number[];
    const walk = (g: number, left: number, ways: number): void => {
      if (g === G) {
        if (left < 0 || left > fillerPool) return;
        const pw = (ways * comb(fillerPool, left)) / comb(pool, Wn);
        if (pw <= 0) return;
        const kept = w.map((have, gi) => Math.min(have, maxLo[gi]!));
        const spent = kept.reduce((a, x) => a + x, 0);
        expKeeps += p * pw * spent;
        const secured: Record<GroupId, number> = {};
        kept.forEach((k, i) => { secured[ids[i]!] = k; });
        const remSizes: Record<GroupId, number> = {};
        counts.forEach((c, i) => { remSizes[ids[i]!] = c - w[i]!; });
        const curve = evaluate(pool - Wn, remSizes, shiftDnf(dnf, secured)).curve;
        total += p * pw * (curve[Math.min(Math.max(0, sched - spent), curve.length - 1)] ?? 0);
        return;
      }
      for (let take = 0; take <= Math.min(counts[g]!, left); take++) {
        w[g] = take;
        walk(g + 1, left - take, ways * comb(counts[g]!, take));
      }
      w[g] = 0;
    };
    walk(0, Wn, 1);
  }
  return { p: total, expKeeps };
}

const scry = (S: number) => ({ group: 'C', examined: S, keepMax: Infinity, keptCostsDraw: true, nonKeptLeavesPool: true });

it('is the defect a constant shift in effective draws?', () => {
  const N = 60, A = 10, B = 6, BR = 4, S = 3;
  const oneNo = [[{ lo: 2 }, { lo: 0 }, { lo: 0 }]];      // monotone: invertible
  for (const copies of [2, 4, 8]) {
    // one DP run gives the whole exact curve
    const curve = exactSelectionCurveDnf(N, [A, B, BR], oneNo, scry(S), copies, 34);
    const rows: string[] = [];
    for (const n of [8, 10, 12, 15, 18, 22]) {
      const m = method(N, [A, B, BR], oneNo, copies, S, n);
      // find delta such that exact(n+delta) == method(n), linear interpolation
      let delta = NaN;
      for (let k = n; k < 33; k++) {
        const a = curve[k]!, b = curve[k + 1]!;
        if (m.p >= a && m.p <= b && b > a) { delta = (k - n) + (m.p - a) / (b - a); break; }
      }
      rows.push(`n=${String(n).padStart(2)} exact=${curve[n]!.toFixed(4)} method=${m.p.toFixed(4)} delta=${delta.toFixed(3)} expKeeps=${m.expKeeps.toFixed(3)} delta/keeps=${(delta / m.expKeeps).toFixed(2)}`);
    }
    console.log(`\ncopies=${copies}:\n  ` + rows.join('\n  '));
  }
}, 900000);

it('does adding draws fix it?', () => {
  const N = 60, A = 10, B = 6, BR = 4, S = 3;
  const oneBrick = [[{ lo: 2 }, { lo: 0 }, { lo: 0, hi: 0 }]];
  const oneNo = [[{ lo: 2 }, { lo: 0 }, { lo: 0 }]];
  for (const [label, clauses] of [['1cl+brick', oneBrick], ['1cl noBrick', oneNo]] as const) {
    for (const copies of [4, 8]) {
      const rows: string[] = [];
      for (const n of [8, 10, 12, 15, 18, 22, 26]) {
        const dp = exactSelectionCurveDnf(N, [A, B, BR], clauses, scry(S), copies, n)[n]!;
        const m = method(N, [A, B, BR], clauses, copies, S, n);
        rows.push(`n=${String(n).padStart(2)} dp=${dp.toFixed(4)} err=${((m.p - dp) * 100).toFixed(3)}pt expKeeps=${m.expKeeps.toFixed(2)} err/keep=${(((m.p - dp) * 100) / Math.max(m.expKeeps, 1e-9)).toFixed(3)}`);
      }
      console.log(`\n${label} copies=${copies}:\n  ` + rows.join('\n  '));
    }
  }
}, 900000);
