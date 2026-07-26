import { describe, it, expect } from 'vitest';
import { minimalVectors } from './frontier';
import { boxCurve } from './boxdp';

function pAt(v: Record<string, number>, groups: string[], N: number, n: number): number {
  const kSum = groups.reduce((s, g) => s + v[g]!, 0);
  if (kSum > N) return 0;
  return boxCurve(N, groups.map((g) => ({ K: v[g]!, lo: 1, hi: v[g]! })))[n]!;
}

describe('4-group budget-crossing case (brute force)', () => {
  it('matches the true optimum and reachability', () => {
    const groups = ['a', 'b', 'c', 'd'];
    const N = 18, n = 6, target = 0.6, maxK = 15;
    let bestFound = 0;
    for (let a = 1; a <= maxK; a++)
      for (let b = 1; b <= maxK; b++)
        for (let c = 1; c <= maxK; c++)
          for (let d = 1; d <= maxK; d++) {
            const v = { a, b, c, d };
            if (a + b + c + d > N) continue;
            bestFound = Math.max(bestFound, pAt(v, groups, N, n));
          }
    const r = minimalVectors(
      { a: { lo: 1, hi: maxK }, b: { lo: 1, hi: maxK }, c: { lo: 1, hi: maxK }, d: { lo: 1, hi: maxK } },
      n, N, target,
    );
    expect(r.bestP).toBeCloseTo(bestFound, 10);
    expect(r.vectors).toHaveLength(0); // bestFound (52.25%) is below target (60%)
  });

  it('a reachable 4-group case finds real vectors, matching a brute-force minimal set', () => {
    const groups = ['a', 'b', 'c', 'd'];
    const N = 18, n = 6, target = 0.45, maxK = 15; // lower target: same box, now reachable
    const all: Array<Record<string, number>> = [];
    for (let a = 1; a <= maxK; a++)
      for (let b = 1; b <= maxK; b++)
        for (let c = 1; c <= maxK; c++)
          for (let d = 1; d <= maxK; d++) all.push({ a, b, c, d });
    const feasible = all.filter((v) => pAt(v, groups, N, n) >= target - 1e-12);
    const minimal = feasible.filter((x) =>
      !feasible.some((y) => groups.every((g) => y[g]! <= x[g]!) && groups.some((g) => y[g]! < x[g]!)));

    const r = minimalVectors(
      { a: { lo: 1, hi: maxK }, b: { lo: 1, hi: maxK }, c: { lo: 1, hi: maxK }, d: { lo: 1, hi: maxK } },
      n, N, target,
    );
    const norm = (vs: Array<Record<string, number>>) =>
      vs.map((v) => groups.map((g) => v[g]).join(',')).sort();
    expect(norm(r.vectors)).toEqual(norm(minimal));
  });
});
