import { expect, it } from 'vitest';
import { copiesNeeded } from './copiesNeeded';
import { evaluate } from './evaluate';

/**
 * Cross-validation against the `manabase` spec written in a separate session.
 *
 * That spec's Stage 1 primitive, `minSources(N, n, k, q)` -- binary search for the
 * fewest sources whose hypergeometric tail clears a confidence threshold -- is the same
 * function as `copiesNeeded` here, arrived at independently. So its anchor is a free
 * external check on this implementation.
 *
 * PRIMARY ANCHOR CONFIRMED: `minSources(99, seen=11, k=1, 0.90) === 18`, along with its
 * companion assertion that 17 sources fall short. EDH multiplayer, where everyone draws
 * on turn one, so cardsSeen(4) = 7 + 4 = 11.
 *
 * SPEC ERROR FOUND: the same section states that in 1v1 Commander, where the starting
 * player skips that draw and cardsSeen(4) = 10, "the anchor becomes 19". It is 20 --
 * nineteen sources give 0.894315, short of 0.90, and twenty give 0.907526. Recorded here
 * rather than in the other repo since this is where the check lives.
 */
it('confirms the manabase Stage 1 anchor, and corrects its 1v1 variant', () => {
  const edh = copiesNeeded({ deckSize: 99, needed: 1, seen: 11, target: 0.90 });
  expect(edh.copies).toBe(18);
  expect(edh.achieved).toBeGreaterThanOrEqual(0.90);
  expect(edh.achievedOneFewer).toBeLessThan(0.90);      // 17 sources fall short
  expect(edh.achieved).toBeCloseTo(0.903815, 6);
  expect(edh.achievedOneFewer).toBeCloseTo(0.888913, 6);

  // 1v1: the spec says 19, but 19 does not clear the bar
  const duel = copiesNeeded({ deckSize: 99, needed: 1, seen: 10, target: 0.90 });
  expect(duel.copies).toBe(20);
  const at19 = evaluate(99, { A: 19 }, { clauses: [{ A: { lo: 1, hi: 19 } }], monotone: true }).curve;
  expect(at19[10]!).toBeLessThan(0.90);
  expect(at19[10]!).toBeCloseTo(0.894315, 6);
});
