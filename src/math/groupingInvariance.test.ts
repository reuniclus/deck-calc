import { expect, it } from 'vitest';
import { bruteSelectionDnfP, bruteSelectionDnfUpperP } from './bruteSelection';
import { exactSelectionCurveDnf, scryEffect } from './selection';
/**
 * GROUPING INVARIANCE. At threshold 1, an OR of two groups is logically identical to a
 * single merged group (`A>=1 | B>=1` == `AB>=1` with `|AB| = |A|+|B|`). The equivalence
 * fails at threshold 2 -- holding one A and one B satisfies the merge but neither clause
 * -- so this test is threshold-1 only.
 *
 * OPTIMAL play cannot depend on how cards are partitioned into groups, so any optimiser
 * must return the same number for both spellings. The clairvoyant brute force satisfies
 * this exactly (0.470687831 both ways). **The DP does not: 0.404761905 against
 * 0.380634921, 2.41pt apart.** So the DP is not finding the optimal policy for bounded
 * scry queries -- both values sit under the clairvoyant ceiling, so it is sub-optimality
 * rather than incoherence.
 *
 * A fixed policy IS legitimately grouping-dependent (it keeps per group), which is why
 * the non-clairvoyant brute force also splits, by 3.12pt. Only the optimiser must not.
 *
 * The discrepancy needs BOTH keeps that cost draws AND an upper bound: with no effect, a
 * draw-shaped effect, or scry without a bound, the DP agrees to floating point.
 */
it('optimal play must not depend on grouping -- the DP currently does', () => {
  // small enough to enumerate every ordering
  const A = 2, B = 2, BR = 2, C = 2, filler = 2; // deck 10
  const n = 4, look = 2;
  const brute = { group: 'C', examined: look, keepMax: Infinity, keptCostsDraw: true, nonKeptLeavesPool: true };
  // OR form: (A>=1 | B>=1) & brick<=0
  const orCounts = { A, B, BR, C, F: filler };
  const orClauses = [
    { need: { A: 1 }, caps: { BR: 0 } },
    { need: { B: 1 }, caps: { BR: 0 } },
  ];
  // merged: (AB>=1) & brick<=0, with |AB| = A+B
  const mCounts = { A: A + B, BR, C, F: filler };
  const mClauses = [{ need: { A: 1 }, caps: { BR: 0 } }];

  const orFixed = bruteSelectionDnfP(orCounts, n, brute, orClauses);
  const orUpper = bruteSelectionDnfUpperP(orCounts, n, brute, orClauses);
  const mFixed = bruteSelectionDnfP(mCounts, n, brute, mClauses);
  const mUpper = bruteSelectionDnfUpperP(mCounts, n, brute, mClauses);
  console.log(`brute OR    : fixed=${orFixed.toFixed(9)} clairvoyant=${orUpper.toFixed(9)}`);
  console.log(`brute merged: fixed=${mFixed.toFixed(9)} clairvoyant=${mUpper.toFixed(9)}`);

  const deck = A + B + BR + C + filler;
  const dpOr = exactSelectionCurveDnf(deck, [A, B, BR], [
    [{ lo: 1 }, { lo: 0 }, { lo: 0, hi: 0 }], [{ lo: 0 }, { lo: 1 }, { lo: 0, hi: 0 }],
  ] as never, scryEffect('C', look), C, n)[n]!;
  const dpM = exactSelectionCurveDnf(deck, [A + B, BR], [
    [{ lo: 1 }, { lo: 0, hi: 0 }],
  ] as never, scryEffect('C', look), C, n)[n]!;
  console.log(`DP    OR    : ${dpOr.toFixed(9)}`);
  console.log(`DP    merged: ${dpM.toFixed(9)}`);
  console.log(`DP split = ${((dpOr - dpM) * 100).toFixed(4)}pt ; brute split(fixed) = ${((orFixed - mFixed) * 100).toFixed(4)}pt ; brute split(clair) = ${((orUpper - mUpper) * 100).toFixed(4)}pt`);

  // The clairvoyant optimiser is grouping-invariant, as any optimiser must be.
  expect(orUpper).toBeCloseTo(mUpper, 12);
  // Neither DP answer may exceed the clairvoyant ceiling.
  expect(dpOr).toBeLessThanOrEqual(orUpper + 1e-12);
  expect(dpM).toBeLessThanOrEqual(mUpper + 1e-12);
  // KNOWN BUG, pinned so a fix flips it: the DP is currently grouping-DEPENDENT here.
  // When this starts failing, the DP has been fixed and this expectation should invert
  // to `toBeCloseTo`.
  expect(Math.abs(dpOr - dpM)).toBeGreaterThan(1e-6);
}, 900000);
