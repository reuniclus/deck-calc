import { describe, expect, it } from 'vitest';
import { scryModifiedQuery, scryModifiedQueryPass, ScryInversionError } from './modifiedQueryScry';
import { exactSelectionCurveDnf } from './selection';
import type { SelectionEffect } from './selection';

const scry = (S: number): SelectionEffect => ({
  group: 'C', examined: S, keepMax: Infinity, keptCostsDraw: true, nonKeptLeavesPool: true,
});

describe('scry modified-query method (research module, not shipping)', () => {
  const N = 60, A = 10, B = 6, BR = 4, S = 3, n = 15;
  const oneClause = [[{ lo: 2 }, { lo: 0 }, { lo: 0, hi: 0 }]];
  const orClause = [
    [{ lo: 2 }, { lo: 0 }, { lo: 0, hi: 0 }],
    [{ lo: 0 }, { lo: 2 }, { lo: 0, hi: 0 }],
  ];

  it('accounts for all probability mass', () => {
    // A shortfall means the enumeration is not a partition. An earlier one-shot
    // joint lost 5-8% here, which is what made it look unsalvageable.
    for (const copies of [1, 4, 8]) {
      for (const clauses of [oneClause, orClause]) {
        const r = scryModifiedQuery(N, [A, B, BR], clauses, copies, S, n);
        expect(r.mass).toBeCloseTo(1, 9);
      }
    }
  }, 120000);

  it('converges, and beats the uncorrected pass', () => {
    for (const copies of [4, 8]) {
      const exact = exactSelectionCurveDnf(N, [A, B, BR], orClause, scry(S), copies, n)[n]!;
      const uncorrected = scryModifiedQueryPass(N, [A, B, BR], orClause, copies, S, n, n).p;
      const fixed = scryModifiedQuery(N, [A, B, BR], orClause, copies, S, n);
      expect(fixed.iterations).toBeLessThan(12);
      expect(Math.abs(fixed.p - exact)).toBeLessThan(Math.abs(uncorrected - exact));
    }
  }, 300000);

  it('still overestimates, and by how much -- pinned so regressions are visible', () => {
    // Documented residual: mean-field bias from iterating on E[keeps]. Worst
    // measured case is ~1.38pt at 8 copies. Pinned as a range, not an equality,
    // so an improvement fails loudly rather than passing silently.
    const exact = exactSelectionCurveDnf(N, [A, B, BR], orClause, scry(S), 8, n)[n]!;
    const fixed = scryModifiedQuery(N, [A, B, BR], orClause, 8, S, n);
    expect(fixed.p).toBeGreaterThan(exact);
    expect((fixed.p - exact) * 100).toBeLessThan(1.5);
  }, 300000);

  it('refuses the stacked-deck oracle case rather than answering it wrongly', () => {
    // Fill every non-query slot with a scry-100. The oracle answer is the
    // no-scry base rate until the needed count, then exactly 1 -- but this
    // module cannot compute it: with examined=100 the windows truncate, `seen`
    // saturates at deck size, and the trigger inversion reads 0 triggers, which
    // sent this to P=1 against a true 0.0316 (a 97pt error). Guarded now, so the
    // limitation is loud instead of silent.
    const deck = 20, pieces = 4, need = 2;
    expect(() => scryModifiedQuery(deck, [pieces], [[{ lo: need }]], deck - pieces, 100, need))
      .toThrow(ScryInversionError);
  });

  it('caps keeps at the draws available to collect them', () => {
    // The clamping correction, tested where the inversion IS valid: a small deck
    // and a look size that cannot truncate. Keeping more pieces than there are
    // draws left must not credit the extra ones.
    const r = scryModifiedQuery(30, [6], [[{ lo: 3 }]], 2, 3, 4);
    const exact = exactSelectionCurveDnf(30, [6], [[{ lo: 3 }]], scry(3), 2, 4)[4]!;
    expect(r.p).toBeGreaterThanOrEqual(exact - 1e-12);
    expect((r.p - exact) * 100).toBeLessThan(2);
  }, 120000);

  it('is exact when nothing is ever kept', () => {
    // No group has lo>0, so no keep can steal a draw and the trigger/keeps
    // coupling disappears. This is the regime test that originally located the
    // coupling as the defect.
    const brickOnly = [[{ lo: 0 }, { lo: 0 }, { lo: 0, hi: 0 }]];
    for (const copies of [1, 8]) {
      const exact = exactSelectionCurveDnf(N, [A, B, BR], brickOnly, scry(S), copies, n)[n]!;
      const r = scryModifiedQuery(N, [A, B, BR], brickOnly, copies, S, n);
      expect(r.p).toBeCloseTo(exact, 9);
    }
  }, 300000);
});
