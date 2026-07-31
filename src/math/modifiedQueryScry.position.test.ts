import { expect, it } from 'vitest';
import { evaluate } from './evaluate';
import { shiftDnf } from './reveal';
import { exactSelectionCurveDnf } from './selection';
import { scryModifiedQuery } from './modifiedQueryScry';
import type { Dnf } from './expr';

function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

/** ONE copy, single-group monotone query, conditioning on the trigger POSITION.
 * Keeps can only be collected by draws that come AFTER the copy was cast, so the
 * cap is (n - p), not (n - 1). */
function onePositional(N: number, A: number, need: number, S: number, n: number): number {
  const pool = N - 1;                 // non-copy cards
  const filler = pool - A;
  const dnf: Dnf = { clauses: [{ A: { lo: need, hi: A } }], monotone: true };
  const sizes = { A };

  // no trigger: the copy is not among the first n library cards
  let total = (1 - n / N) * (evaluate(pool, sizes, dnf).curve[Math.min(n, pool)] ?? 0);

  for (let p = 1; p <= n; p++) {
    const pTrigger = 1 / N;
    const w = Math.min(S, pool);
    const denom = comb(pool, w);
    for (let a = 0; a <= Math.min(A, w); a++) {
      const f = w - a;
      if (f < 0 || f > filler) continue;
      const pw = (comb(A, a) * comb(filler, f)) / denom;
      if (pw <= 0) continue;
      const wanted = Math.min(a, need);
      const collectable = Math.max(0, n - p);      // draws left AFTER the cast
      const kept = Math.min(wanted, collectable);
      const fresh = n - 1 - kept;
      const curve = evaluate(pool - w, { A: A - a }, shiftDnf(dnf, { A: kept })).curve;
      total += pTrigger * pw * (curve[Math.min(Math.max(0, fresh), curve.length - 1)] ?? 0);
    }
  }
  return total;
}

/**
 * Localises the scry method's residual to TRIGGER POSITION, and shows the fix is
 * exact in the single-copy case.
 *
 * The shipped method caps keeps at `draws - triggers`, i.e. it assumes every draw
 * after a cast is available to collect what was kept. But a copy drawn on the last
 * draw has NO draws left, one drawn second-to-last has one, and so on. Averaging
 * over positions without that cap credits keeps that could never be collected --
 * a consistent overestimate, which is what the sweep rows show.
 *
 * This also corrects the earlier "cross-window timing" diagnosis: the defect
 * appears with a SINGLE window, so it is not windows interacting. The cap is
 * per-trigger, `collectable = draws - position`.
 */
it('trigger position explains the one-copy gap, and fixes it exactly', () => {
  for (const [N, A, need, S, n] of [[60, 10, 2, 3, 12], [60, 10, 2, 5, 12], [40, 8, 2, 3, 10], [60, 10, 3, 3, 15]] as const) {
    const exact = exactSelectionCurveDnf(N, [A], [[{ lo: need }]], {
      group: 'C', examined: S, keepMax: Infinity, keptCostsDraw: true, nonKeptLeavesPool: true,
    }, 1, n)[n]!;
    const current = scryModifiedQuery(N, [A], [[{ lo: need }]], 1, S, n).p;
    const positional = onePositional(N, A, need, S, n);
    console.log(`N=${N} A=${A} need=${need} look=${S} n=${n}: exact=${exact.toFixed(6)} current=${((current - exact) * 100).toFixed(3)}pt positional=${((positional - exact) * 100).toFixed(3)}pt`);
    // position conditioning is EXACT here, not merely closer
    expect(positional).toBeCloseTo(exact, 9);
    // and the shipped method is measurably worse, so this is a real difference
    expect(current - exact).toBeGreaterThan(0.002);
  }
}, 120000);
