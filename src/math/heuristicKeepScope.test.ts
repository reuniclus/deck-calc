import { it, expect } from 'vitest';
import { exactSelectionCurveDnf, scryEffect, impulseEffect, drawEffect, ponderEffect } from './selection';

/**
 * Scope check for the `heuristicKeep` policy, and the reason it is NOT the default.
 *
 * An earlier measurement on two configs suggested the heuristic was exact for
 * monotone queries and up to 13x faster, which looked like a free speedup. Across
 * 8 configs x 4 shapes it is exact for draw, impulse and ponder but WRONG for scry
 * on 3 of 8, worst 1.03pt. Both original configs happened to be lucky scry cases.
 *
 * The pattern is the tell: every failure has `keptCostsDraw: true`. When a keep
 * costs a draw there is a real trade over WHICH card to keep, and a fixed rule can
 * choose wrong; when keeps are free the choice is unambiguous. And the regime where
 * the heuristic is reliable is exactly the one where the DP already takes a single
 * forced branch, so there is no max to skip and nothing to gain.
 */
it('is exact for free-keep shapes and wrong for scry', () => {
  const configs: Array<[number, number[], Array<Array<{ lo: number }>>, number, number, number]> = [
    [60, [10, 6], [[{ lo: 2 }, { lo: 0 }]], 8, 3, 12],
    [60, [10, 6], [[{ lo: 2 }, { lo: 1 }]], 8, 3, 12],
    [60, [10, 6], [[{ lo: 3 }, { lo: 2 }]], 8, 3, 15],
    [60, [10, 6], [[{ lo: 2 }, { lo: 0 }], [{ lo: 0 }, { lo: 2 }]], 8, 3, 12],
    [40, [8, 4], [[{ lo: 2 }, { lo: 1 }]], 6, 2, 10],
    [40, [8, 4], [[{ lo: 1 }, { lo: 1 }]], 6, 4, 8],
    [99, [12, 8], [[{ lo: 2 }, { lo: 1 }]], 10, 3, 15],
    [60, [10, 6, 4], [[{ lo: 2 }, { lo: 1 }, { lo: 1 }]], 8, 3, 15],
  ];
  const effects = [scryEffect('C', 3), impulseEffect('C', 3), drawEffect('C', 3), ponderEffect('C', 3)];
  let worst = 0;
  for (const [N, counts, clauses, copies, look, draws] of configs) {
    for (const base of effects) {
      const eff = { ...base, examined: look };
      const a = exactSelectionCurveDnf(N, counts, clauses as never, eff, copies, draws, false)[draws]!;
      const b = exactSelectionCurveDnf(N, counts, clauses as never, eff, copies, draws, true)[draws]!;
      worst = Math.max(worst, Math.abs(a - b));
      if (Math.abs(a - b) > 1e-9) console.log(`DIFFERS N=${N} ${JSON.stringify(clauses)} ${JSON.stringify(base)}: ${a.toFixed(8)} vs ${b.toFixed(8)}`);
    }
  }
  console.log(`worst |exact - heuristic| over ${configs.length * effects.length} monotone cases = ${worst.toExponential(2)}`);
  // Pinned as a NEGATIVE result: the heuristic must stay opt-in. If a future
  // change makes this pass exactly, the default can be revisited.
  expect(worst).toBeGreaterThan(1e-9);
  // and it must never exceed the optimum, since a fixed policy is a lower bound
  for (const [N, counts, clauses, copies, look, draws] of configs) {
    const eff = { ...scryEffect('C', look), examined: look };
    const a = exactSelectionCurveDnf(N, counts, clauses as never, eff, copies, draws, false)[draws]!;
    const b = exactSelectionCurveDnf(N, counts, clauses as never, eff, copies, draws, true)[draws]!;
    expect(b).toBeLessThanOrEqual(a + 1e-12);
  }
}, 900000);
