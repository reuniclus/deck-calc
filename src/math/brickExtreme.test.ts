import { expect, it } from 'vitest';
import { scryModifiedQuery } from './modifiedQueryScry';
import { exactSelectionCurveDnf } from './selection';
const scry = (S: number) => ({ group: 'C', examined: S, keepMax: Infinity, keptCostsDraw: true, nonKeptLeavesPool: true });
function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}
/**
 * Maximal-brick stress test. With `bricks = deck - draws` the non-brick cards number
 * exactly `draws`, so the only winning orderings draw precisely those, and with no
 * cantrips the answer is analytically `1/C(deck, draws)`.
 *
 * Why it matters: this configuration AMPLIFIES the brick-term error from ~0.1pt in
 * ordinary decks to tens of percent relative, which turns a subtle discrepancy into an
 * unmistakable one. It also shows cantrips HELP here -- a window bottoms bricks off the
 * top and lets you reach the non-bricks behind them -- which is the opposite of what
 * was predicted before measuring.
 *
 * MQ over-credits that filtering, and compounds per cantrip: +17.65% with one, +55.30%
 * with two. Its one-cantrip answer is exactly twice the no-cantrip analytic value,
 * which suggests a term counted once per cantrip rather than properly conditioned.
 */
it('bricks = deck - draws: baseline exact, MQ over-credits cantrip filtering', () => {
  const N = 20, n = 6;
  // non-bricks must be exactly n: A pieces + copies + filler = 6
  for (const [label, A, copies, filler] of [
    ['no cantrips', 2, 0, 4],
    ['1 cantrip', 2, 1, 3],
    ['2 cantrips', 2, 2, 2],
  ] as const) {
    const bricks = N - A - copies - filler;
    const q = [[{ lo: 1 }, { lo: 0, hi: 0 }]];
    const analytic = copies === 0 ? 1 / comb(N, n) : NaN;
    const dp = exactSelectionCurveDnf(N, [A, bricks], q as never, scry(3), copies, n)[n]!;
    const mq = scryModifiedQuery(N, [A, bricks], q as never, copies, 3, n).p;
    const rel = dp > 0 ? ((mq - dp) / dp) * 100 : NaN;
    console.log(`${label} (A=${A} bricks=${bricks} filler=${filler}): analytic=${Number.isNaN(analytic) ? 'n/a' : analytic.toExponential(4)} dp=${dp.toExponential(4)} mq=${mq.toExponential(4)} relErr=${rel.toFixed(2)}%`);
    if (copies === 0) {
      // the DP must match the closed form exactly, and so must MQ with no effect
      expect(dp).toBeCloseTo(analytic, 12);
      expect(mq).toBeCloseTo(analytic, 12);
    } else {
      // cantrips HELP in this regime, and MQ over-credits that help
      expect(dp).toBeGreaterThan(1 / comb(N, n));
      expect(mq).toBeGreaterThan(dp);
    }
  }
  // a less degenerate extreme: leave a little slack
  console.log('--- with slack: non-bricks = draws + 2 ---');
  for (const [label, A, copies, filler] of [['no cantrips', 2, 0, 6], ['1 cantrip', 2, 1, 5]] as const) {
    const bricks = N - A - copies - filler;
    const q = [[{ lo: 1 }, { lo: 0, hi: 0 }]];
    const dp = exactSelectionCurveDnf(N, [A, bricks], q as never, scry(3), copies, n)[n]!;
    const mq = scryModifiedQuery(N, [A, bricks], q as never, copies, 3, n).p;
    console.log(`${label} (bricks=${bricks}): dp=${dp.toExponential(4)} mq=${mq.toExponential(4)} relErr=${(((mq - dp) / dp) * 100).toFixed(2)}%`);
  }
}, 600000);
