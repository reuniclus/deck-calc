import { it } from 'vitest';
import { expect } from 'vitest';
import { pmf } from './hyper';

function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

/** P(fewer than `need` of the group among `seen` cards drawn from the pool) */
function needSurvives(pool: number, A: number, seen: number, need: number): number {
  let acc = 0;
  for (let k = 0; k < need; k++) acc += pmf(pool, A, Math.min(seen, pool), k);
  return acc;
}

/**
 * Derives the per-window keep mass `w_i`, which fixes the interpolation weight
 * `lambda` between the bracket's endpoints without any fitted constant.
 *
 * Background: MQ caps every keep by the EARLIEST trigger's position, which
 * over-credits later windows; capping by the latest under-credits. The truth sits
 * between, at `lambda = sum_i w_i * (i-1)/(t-1)`. Even spread would give lambda =
 * 1/2 exactly (the algebra cancels every parameter), but the measured value is
 * 0.2614, so keeps are FRONT-LOADED.
 *
 * The constraint that makes `w_i` tractable: total keeps never exceed `need`, since
 * nothing is kept once the requirement is met. So
 *
 *   w_i proportional to P(need unmet when window i fires) x P(window holds a needed card)
 *
 * both closed-form hypergeometrics. This predicts lambda = 0.214-0.238 on the config
 * where 0.2614 was measured -- within ~20% relative, with nothing fitted -- and it
 * moves with the parameters in mechanically sensible directions.
 */
it('derives w_i, and lambda moves with need and look as predicted', () => {
  for (const [label, N, A, copies, S, n, need] of [
    ['base', 60, 10, 8, 3, 12, 2],
    ['need3', 60, 10, 8, 3, 15, 3],
    ['look5', 60, 10, 8, 5, 12, 2],
    ['deck40', 40, 8, 6, 3, 10, 2],
  ] as const) {
    const pool = N - copies;
    const pWindowHasNeeded = 1 - comb(pool - A, S) / comb(pool, S);
    for (const t of [2, 3]) {
      const w: number[] = [];
      for (let i = 1; i <= t; i++) {
        const meanPos = (i * (n + 1)) / (t + 1);
        const seenBefore = Math.round(meanPos + (i - 1) * S);
        w.push(needSurvives(pool, A, seenBefore, need) * pWindowHasNeeded);
      }
      const tot = w.reduce((a, b) => a + b, 0);
      const wn = w.map((v) => v / tot);
      const lambda = wn.reduce((acc, wi, idx) => acc + wi * (idx / (t - 1)), 0);
      console.log(`${label} t=${t}: w=[${wn.map((v) => v.toFixed(3)).join(', ')}] lambda=${lambda.toFixed(4)}`);
      // front-loaded: never the even-spread value of 1/2
      expect(lambda).toBeLessThan(0.5);
      expect(wn[0]!).toBeGreaterThan(wn[1]!);
    }
  }
  // and the directions: more need pushes mass later, bigger windows pull it earlier
  const lam = (N: number, A: number, copies: number, S: number, n: number, need: number, t: number): number => {
    const pool = N - copies;
    const q = 1 - comb(pool - A, S) / comb(pool, S);
    const w: number[] = [];
    for (let i = 1; i <= t; i++) {
      const seenBefore = Math.round((i * (n + 1)) / (t + 1) + (i - 1) * S);
      w.push(needSurvives(pool, A, seenBefore, need) * q);
    }
    const tot = w.reduce((a, b) => a + b, 0);
    return w.reduce((acc, wi, idx) => acc + (wi / tot) * (idx / (t - 1)), 0);
  };
  expect(lam(60, 10, 8, 3, 12, 3, 2)).toBeGreaterThan(lam(60, 10, 8, 3, 12, 2, 2));
  expect(lam(60, 10, 8, 5, 12, 2, 2)).toBeLessThan(lam(60, 10, 8, 3, 12, 2, 2));
});
