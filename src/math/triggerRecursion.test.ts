import { describe, expect, it } from 'vitest';
import { triggerRecursion } from './triggerRecursion';
import { exactSelectionCurveDnf } from './selection';

const scry = (S: number) => ({
  group: 'C', examined: S, keepMax: Infinity, keptCostsDraw: true, nonKeptLeavesPool: true,
});

describe('per-trigger recursion', () => {
  const configs: Array<[number, number, number, number, number, number]> = [
    // deck, group, need, copies, look, draws
    [60, 10, 2, 1, 3, 12],
    [60, 10, 2, 8, 3, 12],
    [60, 10, 2, 8, 3, 6],
    [60, 10, 2, 8, 5, 12],
    [60, 10, 3, 8, 3, 15],
    [40, 8, 2, 6, 2, 10],
    [40, 8, 1, 6, 4, 8],
  ];

  for (const [deck, A, need, copies, look, draws] of configs) {
    it(`is exact: deck=${deck} A=${A} need=${need} copies=${copies} look=${look} draws=${draws}`, () => {
      const dp = exactSelectionCurveDnf(deck, [A], [[{ lo: need }]], scry(look), copies, draws)[draws]!;
      const rec = triggerRecursion(deck, A, need, copies, look, draws);
      expect(rec.p).toBeCloseTo(dp, 10);
    }, 120000);
  }

  it('reduces to plain hypergeometry with no copies', () => {
    const dp = exactSelectionCurveDnf(60, [10], [[{ lo: 2 }]], scry(3), 0, 12)[12]!;
    expect(triggerRecursion(60, 10, 2, 0, 3, 12).p).toBeCloseTo(dp, 12);
  });

  it('is monotone in draws and in copies', () => {
    let prev = -1;
    for (const draws of [4, 8, 12, 16]) {
      const v = triggerRecursion(60, 10, 2, 6, 3, draws).p;
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    prev = -1;
    for (const copies of [0, 2, 4, 8]) {
      const v = triggerRecursion(60, 10, 2, copies, 3, 12).p;
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
  }, 60000);

  it('keeps the state count small', () => {
    // 722 states measured for the heaviest config here; the DP explores far more.
    expect(triggerRecursion(60, 10, 2, 8, 3, 12).calls).toBeLessThan(2000);
  });
});
