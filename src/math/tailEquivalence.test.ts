import { expect, it } from 'vitest';
import { scryModifiedQueryPass } from './modifiedQueryScry';
import { exactSelectionCurveDnf } from './selection';
const scry = (S: number) => ({ group: 'C', examined: S, keepMax: Infinity, keptCostsDraw: true, nonKeptLeavesPool: true });

// Isolated equivalence check: for a PURE UPPER BOUND query (the tail state, where
// every lo is already met so nothing is ever kept), does the closed-form single
// pass agree with the exact DP? This is the step both tail attempts skipped.
it('closed form vs DP on pure upper-bound queries', () => {
  const look = 3;
  for (const [pool, A, BR, copies, cap, d] of [
    [56, 10, 4, 8, 0, 12],
    [56, 10, 4, 8, 0, 8],
    [56, 10, 4, 8, 2, 12],
    [56, 10, 4, 8, 1, 15],
    [40, 8, 3, 6, 0, 10],
    [30, 6, 3, 4, 1, 8],
  ] as const) {
    const clauses = [[{ lo: 0 }, { lo: 0, hi: cap }]];
    const dp = exactSelectionCurveDnf(pool, [A, BR], clauses, scry(look), copies, d)[d]!;
    const cf = scryModifiedQueryPass(pool, [A, BR], clauses, copies, look, d, d).p;
    console.log(`pool=${pool} A=${A} brick=${BR}/cap${cap} copies=${copies} d=${d}: dp=${dp.toFixed(8)} closed=${cf.toFixed(8)} diff=${((cf - dp) * 100).toFixed(4)}pt`);
    expect(cf).toBeCloseTo(dp, 10);
  }
}, 300000);
