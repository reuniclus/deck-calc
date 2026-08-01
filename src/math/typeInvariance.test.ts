import { expect, it } from 'vitest';
import { exactDrawCurveMulti, exactSelectionCurveDnf, drawEffect } from './selection';
import type { Dnf } from './expr';
/**
 * TYPE INVARIANCE: declaring `T` copies as one effect type must equal declaring them as
 * several identical types summing to `T`. Any correct multi-type engine satisfies this,
 * and it catches a whole class of per-type bookkeeping error immediately -- it is the
 * effect-type analogue of `groupingInvariance.test.ts`, which is what exposed the DP's
 * sub-optimality under bounds.
 *
 * The live draw-shaped multi-type path passes to floating point AND agrees with the
 * independent single-effect DP, so it is sound. The test exists mainly as the gate a
 * scry/impulse multi-type engine must pass before being trusted: that engine needs
 * `remC` as a vector and window compositions over `groups + T` copy dimensions, which is
 * exactly the kind of bookkeeping this detects.
 */
it('declaring copies as one type or several identical types must agree', () => {
  const deck = 60, A = 10, B = 6, look = 3, draws = 12;
  const dnf: Dnf = { clauses: [{ A: { lo: 2, hi: A }, B: { lo: 1, hi: B } }], monotone: true };
  const sizes = { A, B };
  // 8 copies declared as ONE type
  const one = exactDrawCurveMulti(dnf, sizes, deck, [{ count: 8, examined: look }], draws)[draws]!;
  // 8 copies declared as TWO identical types of 4
  const split = exactDrawCurveMulti(dnf, sizes, deck, [
    { count: 4, examined: look }, { count: 4, examined: look },
  ], draws)[draws]!;
  // and as FOUR types of 2
  const four = exactDrawCurveMulti(dnf, sizes, deck, [
    { count: 2, examined: look }, { count: 2, examined: look },
    { count: 2, examined: look }, { count: 2, examined: look },
  ], draws)[draws]!;
  // cross-check against the single-effect DP
  const dp = exactSelectionCurveDnf(deck, [A, B], [[{ lo: 2 }, { lo: 1 }]] as never, drawEffect('C', look), 8, draws)[draws]!;
  console.log(`1 type x8 = ${one.toFixed(9)}`);
  console.log(`2 types x4 = ${split.toFixed(9)}  (${((split - one) * 100).toExponential(3)}pt)`);
  console.log(`4 types x2 = ${four.toFixed(9)}  (${((four - one) * 100).toExponential(3)}pt)`);
  console.log(`single-effect DP = ${dp.toFixed(9)}  (${((dp - one) * 100).toExponential(3)}pt)`);
  expect(split).toBeCloseTo(one, 11);
  expect(four).toBeCloseTo(one, 11);
  expect(dp).toBeCloseTo(one, 10);
}, 300000);
