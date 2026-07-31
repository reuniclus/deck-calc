import { describe, expect, it } from 'vitest';
import { cheapTail } from './cheapTail';
import { exactSelectionCurveDnf } from './selection';

const scry = (S: number) => ({
  group: 'C', examined: S, keepMax: Infinity, keptCostsDraw: true, nonKeptLeavesPool: true,
});

describe('cheap exact tail for pure upper-bound queries', () => {
  const look = 3;
  const cases: Array<[number, number, number, number, number, number]> = [
    // pool, group, bricks, copies, cap, draws
    [56, 10, 4, 8, 0, 12],
    [56, 10, 4, 8, 0, 8],
    [56, 10, 4, 8, 2, 12],
    [56, 10, 4, 8, 1, 15],
    [40, 8, 3, 6, 0, 10],
    [30, 6, 3, 4, 1, 8],
  ];

  for (const [pool, A, BR, copies, cap, d] of cases) {
    it(`exact: pool=${pool} bricks=${BR} cap=${cap} copies=${copies} draws=${d}`, () => {
      // With no keeps the process is draw-shaped, so the cached slot distribution
      // applies and window contents are irrelevant -- only that a window consumed
      // cards. That is what removes the enumeration the general closed-form pass
      // needs, and it costs nothing in accuracy.
      const dp = exactSelectionCurveDnf(
        pool, [A, BR], [[{ lo: 0 }, { lo: 0, hi: cap }]], scry(look), copies, d,
      )[d]!;
      expect(cheapTail(pool, BR, cap, copies, look, d)).toBeCloseTo(dp, 10);
    }, 120000);
  }

  it('a cap at or above the brick count is vacuous', () => {
    const v = cheapTail(56, 4, 4, 8, look, 12);
    expect(v).toBeCloseTo(1, 10);
  });

  it('more copies help, since a bottomed brick cannot reach hand', () => {
    let prev = -1;
    for (const copies of [0, 2, 4, 8]) {
      const v = cheapTail(56, 4, 0, copies, look, 12);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
  });
});
