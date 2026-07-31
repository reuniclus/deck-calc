import { describe, expect, it } from 'vitest';
import { forwardScry } from './forwardScry';
import { exactSelectionCurveDnf } from './selection';

const scry = (S: number) => ({
  group: 'C', examined: S, keepMax: Infinity, keptCostsDraw: true, nonKeptLeavesPool: true,
});

describe('forward mass propagation cross-checks the DP at realistic deck sizes', () => {
  const N = 60, A = 10, B = 6, BR = 4;
  const cases: Array<[string, number[], number[], number, number, number]> = [
    ['one group, 8 copies, 12 draws', [A, B, BR], [2, 0, 0], 8, 3, 12],
    ['one group, 8 copies, 6 draws', [A, B, BR], [2, 0, 0], 8, 3, 6],
    ['one group, look 5', [A, B, BR], [2, 0, 0], 8, 5, 12],
    ['two groups', [A, B, BR], [2, 1, 0], 8, 3, 12],
  ];

  for (const [label, counts, needs, copies, look, draws] of cases) {
    it(`agrees exactly with the DP: ${label}`, () => {
      // Independent implementation: forward mass vs backward value function, no
      // shared code. Brute force cannot reach 60 cards, so this is the only
      // exact check available at realistic sizes.
      const dp = exactSelectionCurveDnf(
        N, counts, [needs.map((n) => ({ lo: n }))], scry(look), copies, draws,
      )[draws]!;
      const fwd = forwardScry(N, counts, needs, copies, look, draws, 0);
      expect(fwd.p).toBeCloseTo(dp, 12);
      expect(fwd.dropped).toBe(0);
    }, 120000);
  }

  it('pruning yields a rigorous interval containing the exact value', () => {
    const dp = exactSelectionCurveDnf(
      N, [A, B, BR], [[{ lo: 2 }, { lo: 0 }, { lo: 0 }]], scry(3), 8, 12,
    )[12]!;
    const fwd = forwardScry(N, [A, B, BR], [2, 0, 0], 8, 3, 12, 1e-9);
    // [p, p + dropped] must bracket the truth, and be far tighter than the bar
    expect(fwd.p).toBeLessThanOrEqual(dp + 1e-12);
    expect(fwd.p + fwd.dropped).toBeGreaterThanOrEqual(dp - 1e-12);
    expect(fwd.dropped * 100).toBeLessThan(0.01);
  }, 120000);

  it('prunes fewer states than the interval budget would suggest', () => {
    // Records why this is not a speed win: the mass is not concentrated, so a
    // 1e-9 threshold removes only about a third of the states.
    const full = forwardScry(N, [A, B, BR], [2, 0, 0], 8, 3, 12, 0);
    const pruned = forwardScry(N, [A, B, BR], [2, 0, 0], 8, 3, 12, 1e-9);
    expect(pruned.states).toBeGreaterThan(full.states * 0.5);
  }, 120000);
});
