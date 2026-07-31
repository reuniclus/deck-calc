import { describe, expect, it } from 'vitest';
import { exactSelectionCurveDnf, scryEffect } from './selection';

const look = 3;
const N = 60, A = 10, B = 6, BR = 4;

describe('heuristic keep policy in the DP', () => {
  // Replaces the max over commit vectors with one rule: keep toward the clause
  // nearest completion, tie-breaking toward the scarcer group.
  const both = (counts: number[], clauses: Array<Array<{ lo: number; hi?: number }>>, draws: number) => ({
    exact: exactSelectionCurveDnf(N, counts, clauses as never, scryEffect('C', look), 8, draws, false)[draws]!,
    heur: exactSelectionCurveDnf(N, counts, clauses as never, scryEffect('C', look), 8, draws, true)[draws]!,
  });

  it('is EXACT on monotone queries, where no bound can punish a keep', () => {
    // Measured 0.0000pt on both, and faster (94ms vs 165ms, 63ms vs 848ms). Not a
    // proof: the ordering only matters when the keep budget binds, and that it is
    // optimal there is measured rather than argued. Do not make it the default
    // without settling that.
    const one = both([A, B, BR], [[{ lo: 2 }, { lo: 0 }, { lo: 0 }]], 12);
    expect(one.heur).toBeCloseTo(one.exact, 10);
    const two = both([A, B, BR], [[{ lo: 2 }, { lo: 1 }, { lo: 0 }]], 12);
    expect(two.heur).toBeCloseTo(two.exact, 10);
  }, 120000);

  it('loses real accuracy once an upper bound exists', () => {
    // -2.2pt and -3.2pt: a fixed policy cannot see that keeping a card now may
    // force a busting draw later, which is exactly what the max is for.
    const brick = both([A, B, BR], [[{ lo: 2 }, { lo: 0 }, { lo: 0, hi: 0 }]], 15);
    expect(brick.heur).toBeLessThan(brick.exact);
    expect((brick.exact - brick.heur) * 100).toBeGreaterThan(1);
  }, 120000);

  it('never exceeds the optimum, since any fixed policy is a lower bound', () => {
    for (const clauses of [
      [[{ lo: 2 }, { lo: 0 }, { lo: 0 }]],
      [[{ lo: 2 }, { lo: 1 }, { lo: 0 }]],
      [[{ lo: 2 }, { lo: 0 }, { lo: 0, hi: 0 }]],
    ]) {
      const r = both([A, B, BR], clauses as never, 12);
      expect(r.heur).toBeLessThanOrEqual(r.exact + 1e-12);
    }
  }, 300000);
});
