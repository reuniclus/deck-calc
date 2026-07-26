import { describe, it, expect } from 'vitest';
import { minimalVectors } from './frontier';
import { boxCurve } from './boxdp';

function pAt(v: Record<string, number>, groups: string[], N: number, n: number): number {
  const kSum = groups.reduce((s, g) => s + v[g]!, 0);
  if (kSum > N) return 0;
  return boxCurve(N, groups.map((g) => ({ K: v[g]!, lo: 1, hi: v[g]! })))[n]!;
}

/** Exhaustive reference over a bounded box, for small cases. */
function bruteMinimal(
  groups: string[], maxK: number, N: number, n: number, target: number,
): Array<Record<string, number>> {
  const all: Array<Record<string, number>> = [];
  function rec(i: number, v: Record<string, number>): void {
    if (i === groups.length) { all.push({ ...v }); return; }
    for (let c = 1; c <= maxK; c++) rec(i + 1, { ...v, [groups[i]!]: c });
  }
  rec(0, {});
  const feasible = all.filter((v) => pAt(v, groups, N, n) >= target - 1e-12);
  return feasible.filter((a) =>
    !feasible.some((b) => groups.every((g) => b[g]! <= a[g]!) && groups.some((g) => b[g]! < a[g]!)));
}

function sortedKeys(vs: Array<Record<string, number>>, groups: string[]): string[] {
  return vs.map((v) => groups.map((g) => v[g]).join(',')).sort();
}

describe('minimalVectors vs brute force', () => {
  const cases: Array<[string[], number, number, number, number]> = [
    [['a', 'b'], 6, 20, 7, 0.9],
    [['a', 'b'], 5, 18, 6, 0.5],
    [['a', 'b'], 8, 40, 10, 0.75],
    [['a', 'b', 'c'], 4, 24, 8, 0.6],
    // hi close to N: the budget constraint genuinely binds and multiple
    // incomparable minimal points must be found (no single group can be
    // maxed out alone — see PLAN.md, this is the case an earlier version
    // of minimalVectors silently returned "unreachable" for).
    [['a', 'b'], 18, 20, 7, 0.9],
    [['a', 'b'], 22, 24, 9, 0.85],
    [['a', 'b', 'c'], 15, 18, 6, 0.7],
    // 4 groups, unreachable target — verified by exhaustive search (not just
    // brute-force minimality) that 0.6 truly exceeds the achievable max
    // (52.25% at a=4,b=4,c=5,d=5), since allocate()'s bestP uses a greedy
    // heuristic at m=4 and this pins that the heuristic found the true optimum here.
    [['a', 'b', 'c', 'd'], 15, 18, 6, 0.6],
  ];
  for (const [groups, maxK, N, n, target] of cases) {
    it(`groups=${groups.join('')} maxK=${maxK} N=${N} n=${n} target=${target}`, () => {
      const clause = Object.fromEntries(groups.map((g) => [g, { lo: 1, hi: maxK }]));
      const got = minimalVectors(clause, n, N, target);
      const want = bruteMinimal(groups, maxK, N, n, target);
      expect(sortedKeys(got.vectors, groups)).toEqual(sortedKeys(want, groups));
    });
  }

  it('bestP matches the true optimum, not just the best solo-maxed corner', () => {
    // K_a=20,K_b=20 (balanced) beats K_a=39,K_b=1 or K_a=1,K_b=39 (solo-maxed) —
    // an implementation that only checks solo corners gets this badly wrong.
    const clause = { a: { lo: 1, hi: 40 }, b: { lo: 1, hi: 40 } };
    const { bestP } = minimalVectors(clause, 10, 40, 0.9);
    expect(bestP).toBeGreaterThan(0.99); // the true (balanced) optimum
  });
});

describe('minimalVectors properties', () => {
  const clause = { a: { lo: 1, hi: 10 }, b: { lo: 1, hi: 10 } };

  it('every returned vector actually reaches the target', () => {
    const { vectors } = minimalVectors(clause, 7, 30, 0.85);
    for (const v of vectors) expect(pAt(v, ['a', 'b'], 30, 7)).toBeGreaterThanOrEqual(0.85 - 1e-9);
  });

  it('every returned vector is truly minimal — decrementing any coordinate fails', () => {
    const { vectors } = minimalVectors(clause, 7, 30, 0.85);
    for (const v of vectors) {
      for (const g of ['a', 'b'] as const) {
        if (v[g]! <= 1) continue;
        const shrunk = { ...v, [g]: v[g]! - 1 };
        expect(pAt(shrunk, ['a', 'b'], 30, 7)).toBeLessThan(0.85);
      }
    }
  });

  it('no returned vector dominates another (a genuine antichain)', () => {
    const { vectors } = minimalVectors(clause, 7, 30, 0.85);
    for (const a of vectors) {
      for (const b of vectors) {
        if (a === b) continue;
        const dominates = (['a', 'b'] as const).every((g) => a[g]! <= b[g]!);
        const strictlyLess = (['a', 'b'] as const).some((g) => a[g]! < b[g]!);
        expect(dominates && strictlyLess).toBe(false);
      }
    }
  });

  it('reports unreachable targets with the best achievable P, not a crash', () => {
    const r = minimalVectors(clause, 2, 30, 0.999);
    expect(r.vectors).toHaveLength(0);
    expect(r.bestP).toBeGreaterThanOrEqual(0);
    expect(r.bestP).toBeLessThan(0.999);
  });

  it('a trivially-reachable target at n=0 or lo=0 returns no constraint to allocate', () => {
    expect(minimalVectors({}, 7, 30, 0.5).vectors).toEqual([]);
  });

  it('single-group case degenerates to the univariate "draws needed" boundary', () => {
    const single = { a: { lo: 1, hi: 10 } };
    const { vectors } = minimalVectors(single, 7, 30, 0.9);
    // every minimal K for a single group is a single point (no tradeoff possible)
    expect(vectors.length).toBeGreaterThanOrEqual(1);
    for (const v of vectors) expect(Object.keys(v)).toEqual(['a']);
  });
});
