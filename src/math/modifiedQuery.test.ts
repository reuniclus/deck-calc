import { describe, expect, it } from 'vitest';
import { modifiedQueryUpperBound } from './modifiedQuery';
import { exactSelectionCurveDnf, impulseEffect } from './selection';

describe('modified-query upper bound for capped-keep effects', () => {
  const cases: Array<[number, number[], number, number, number, number]> = [
    // deckSize, counts, copies, examined, keepMax, draws
    [40, [8], 3, 2, 1, 10],
    [40, [8], 4, 4, 1, 10],
    [40, [6, 3], 3, 2, 1, 10],
    [12, [3], 2, 2, 1, 5],
  ];

  it('never falls below the exact value (it is a relaxation)', () => {
    // Two idealizations -- a pooled keep budget and choosing keeps with every
    // window visible -- can only add power, so this must dominate the DP. A
    // violation would mean the relaxation is not actually a relaxation.
    for (const [N, counts, copies, E, K, n] of cases) {
      const clauses = counts.length === 1 ? [[{ lo: 2 }]] : [[{ lo: 2 }, { lo: 1 }]];
      const bound = modifiedQueryUpperBound(N, counts, clauses, copies, E, K, n);
      const exact = exactSelectionCurveDnf(N, counts, clauses, impulseEffect('C', E), copies, n)[n]!;
      expect(bound).toBeGreaterThanOrEqual(exact - 1e-12);
    }
  });

  it('is tight on a realistic sparse deck, which is where it gets used', () => {
    // The intended regime: exact DP when affordable, this when not. Sparse
    // relevant cards make the pooled-budget idealization nearly free.
    //
    // Tightness depends on the DRAW HORIZON, not just the deck: this same query
    // measures +0.02pt at 15 draws and +0.20pt here at 10. More draws dilute
    // the pooled-budget idealization, because there is time to draw the pieces
    // anyway. Asserted at what it actually measures rather than at the
    // flattering number from the longer horizon.
    const clauses = [[{ lo: 2 }, { lo: 0 }, { lo: 0, hi: 0 }], [{ lo: 0 }, { lo: 2 }, { lo: 0, hi: 0 }]];
    const bound = modifiedQueryUpperBound(60, [10, 6, 4], clauses, 8, 3, 1, 10);
    const exact = exactSelectionCurveDnf(60, [10, 6, 4], clauses, impulseEffect('C', 3), 8, 10)[10]!;
    expect(bound - exact).toBeLessThan(0.003);
    expect(bound).toBeGreaterThanOrEqual(exact - 1e-12);
  }, 60000);

  it('loosens on small dense decks, as documented', () => {
    // Recorded rather than hidden: the bound is worst exactly where the exact
    // DP is cheapest, which is what makes the split safe.
    const bound = modifiedQueryUpperBound(12, [3], [[{ lo: 2 }]], 2, 2, 1, 5);
    const exact = exactSelectionCurveDnf(12, [3], [[{ lo: 2 }]], impulseEffect('C', 2), 2, 5)[5]!;
    expect(bound - exact).toBeGreaterThan(0.002);
    expect(bound - exact).toBeLessThan(0.02);
  });

  it('agrees with the exact DP when no copies are in the deck', () => {
    const bound = modifiedQueryUpperBound(40, [8], [[{ lo: 2 }]], 0, 2, 1, 10);
    const exact = exactSelectionCurveDnf(40, [8], [[{ lo: 2 }]], impulseEffect('C', 2), 0, 10)[10]!;
    expect(bound).toBeCloseTo(exact, 12);
  });
});
