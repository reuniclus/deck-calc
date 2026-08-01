import { expect, it } from 'vitest';
import { exactSelectionCurveDnf, scryEffect, drawEffect, impulseEffect, ponderEffect } from './selection';
/**
 * SHIPPABLE SCOPE. Grouping invariance (see `groupingInvariance.test.ts`) is a necessary
 * condition for an optimiser: at threshold 1, `A>=1 | B>=1` is the same query as
 * `AB>=1`, so any correct optimiser must return the same number for both. This test
 * establishes WHICH effect shapes satisfy it under an upper bound, and therefore which
 * results are safe to expose.
 *
 * Result: only SCRY splits. The defect needs all three of -- keeps cost a draw, non-kept
 * cards leave the pool, and an upper bound. Ponder pays the draw cost but never bottoms,
 * and is clean; draw and impulse keep for free and are clean.
 *
 * So: draw, impulse and ponder are exact for any query; scry is exact for monotone
 * queries; scry with an upper bound is a valid LOWER bound (an achievable policy, just
 * not provably optimal) and should be labelled rather than hidden -- understating is the
 * safe direction for a deck-building decision.
 *
 * The shipped cantrips card is draw-shaped, so the live product is unaffected.
 */
it('only scry splits under a bound -- everything else is exact', () => {
  const N = 60, A = 10, B = 6, BR = 4, look = 3, copies = 8, draws = 15;
  const orC = [A, B, BR];
  const orQ = [[{ lo: 1 }, { lo: 0 }, { lo: 0, hi: 0 }], [{ lo: 0 }, { lo: 1 }, { lo: 0, hi: 0 }]];
  const mC = [A + B, BR];
  const mQ = [[{ lo: 1 }, { lo: 0, hi: 0 }]];
  for (const [name, eff] of [
    ['draw', drawEffect('C', look)],
    ['impulse keep1', { ...impulseEffect('C', look), keepMax: 1 }],
    ['impulse keep=look', { ...impulseEffect('C', look), keepMax: look }],
    ['scry', scryEffect('C', look)],
    ['ponder', ponderEffect('C', look)],
  ] as const) {
    const o = exactSelectionCurveDnf(N, orC, orQ as never, eff, copies, draws)[draws]!;
    const m = exactSelectionCurveDnf(N, mC, mQ as never, eff, copies, draws)[draws]!;
    const d = (o - m) * 100;
    console.log(`${name.padEnd(16)}: or=${o.toFixed(9)} merged=${m.toFixed(9)} split=${Math.abs(d) < 1e-9 ? 'NONE' : d.toFixed(4) + 'pt'}`);
    if (name === 'scry') {
      // known defect, pinned: when this fails, scry has been fixed
      expect(Math.abs(d)).toBeGreaterThan(1e-6);
    } else {
      expect(o).toBeCloseTo(m, 10);
    }
  }
}, 900000);
