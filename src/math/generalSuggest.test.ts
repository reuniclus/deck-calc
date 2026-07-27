import { describe, it, expect } from 'vitest';
import { generalMinimalVectors, enumerateCompositionCurves, pickMinimalVectors, SearchTooLargeError } from './generalSuggest';
import { parseQuery } from './parse';
import { normalize } from './normalize';
import { evaluate } from './evaluate';

const resolve = (n: string) => ({ land: 'g0', ramp: 'g1' }[n.toLowerCase()] ?? null);

describe('generalMinimalVectors (non-monotone / multi-clause, no staircase shortcut)', () => {
  it('handles the exact reported case: OR of two negated clauses (mana flood avoidance)', () => {
    // (not land>=4) OR (not land>=3 AND not ramp>=1)
    const ast = parseQuery('!land>=4 | (!land>=3 & !ramp>=1)', resolve);
    const groupIds = ['g0', 'g1'];
    const deckSize = 99, n = 13, target = 0.9;
    const { vectors, bestP } = generalMinimalVectors(ast, groupIds, deckSize, n, target, { g0: 38, g1: 6 });
    expect(vectors.length).toBeGreaterThan(0);
    expect(bestP).toBeGreaterThanOrEqual(target);

    // independently verify EVERY returned vector actually reaches target
    for (const v of vectors) {
      const sizes = { g0: v.g0!, g1: v.g1! };
      const p = evaluate(deckSize, sizes, normalize(ast, sizes)).curve[n]!;
      expect(p).toBeGreaterThanOrEqual(target - 1e-9);
    }
  });

  it('minimality holds: no returned vector can have any coordinate reduced while still reaching target', () => {
    const ast = parseQuery('!land>=4 | (!land>=3 & !ramp>=1)', resolve);
    const groupIds = ['g0', 'g1'];
    const deckSize = 30, n = 8, target = 0.85;
    const { vectors } = generalMinimalVectors(ast, groupIds, deckSize, n, target, { g0: 10, g1: 4 });
    for (const v of vectors) {
      for (const g of groupIds) {
        if (v[g]! <= 0) continue;
        const lowered = { ...v, [g]: v[g]! - 1 };
        const sizes = { g0: lowered.g0!, g1: lowered.g1! };
        const p = evaluate(deckSize, sizes, normalize(ast, sizes)).curve[n]!;
        expect(p).toBeLessThan(target); // lowering ANY coordinate must drop below target
      }
    }
  });

  it('completeness within bounds: every feasible point not returned is dominated by a returned vector', () => {
    // Small deck so a full independent brute-force cross-check is cheap.
    const ast = parseQuery('!land>=3', resolve);
    const groupIds = ['g0'];
    const deckSize = 12, n = 5, target = 0.5;
    const { vectors } = generalMinimalVectors(ast, groupIds, deckSize, n, target, { g0: 4 });

    const allFeasible: number[] = [];
    for (let k = 0; k <= deckSize; k++) {
      const p = evaluate(deckSize, { g0: k }, normalize(ast, { g0: k })).curve[n]!;
      if (p >= target - 1e-9) allFeasible.push(k);
    }
    for (const k of allFeasible) {
      const dominated = vectors.some((v) => v.g0! <= k);
      expect(dominated).toBe(true);
    }
  });

  it('bestP matches an independent max computed by direct enumeration', () => {
    const ast = parseQuery('!land>=4 | (!land>=3 & !ramp>=1)', resolve);
    const groupIds = ['g0', 'g1'];
    const deckSize = 20, n = 6, target = 0.99; // near-impossible, forces bestP to matter
    const { bestP } = generalMinimalVectors(ast, groupIds, deckSize, n, target, { g0: 6, g1: 2 });

    let trueMax = 0;
    for (let a = 0; a <= deckSize; a++) {
      for (let b = 0; b <= deckSize - a; b++) {
        const sizes = { g0: a, g1: b };
        const p = evaluate(deckSize, sizes, normalize(ast, sizes)).curve[n]!;
        trueMax = Math.max(trueMax, p);
      }
    }
    expect(bestP).toBeCloseTo(trueMax, 10);
  });

  it('throws SearchTooLargeError for more than 4 groups', () => {
    const ast = parseQuery('!a>=1 | !b>=1 | !c>=1 | !d>=1 | !e>=1', (nm) =>
      ({ a: 'g0', b: 'g1', c: 'g2', d: 'g3', e: 'g4' }[nm.toLowerCase()] ?? null));
    expect(() => generalMinimalVectors(ast, ['g0', 'g1', 'g2', 'g3', 'g4'], 20, 5, 0.5,
      { g0: 2, g1: 2, g2: 2, g3: 2, g4: 2 })).toThrow(SearchTooLargeError);
  });

  it('throws SearchTooLargeError for an obviously too-large deck+group combination', () => {
    const ast = parseQuery('!land>=4', resolve);
    expect(() => generalMinimalVectors(ast, ['g0', 'g1'], 1000, 5, 0.5, { g0: 100, g1: 100 }))
      .toThrow(SearchTooLargeError);
  });

  it('returns bestP=1, empty vectors for no referenced groups', () => {
    const ast = parseQuery('true', resolve);
    expect(generalMinimalVectors(ast, [], 40, 7, 0.5, {})).toEqual({ bestP: 1, vectors: [] });
  });
});

describe('enumerateCompositionCurves + pickMinimalVectors (split, cacheable)', () => {
  it('combined, produce IDENTICAL results to the monolithic generalMinimalVectors', () => {
    const ast = parseQuery('!land>=4 | (!land>=3 & !ramp>=1)', resolve);
    const groupIds = ['g0', 'g1'];
    const deckSize = 99, n = 13, target = 0.9, sizes = { g0: 38, g1: 6 };

    const monolithic = generalMinimalVectors(ast, groupIds, deckSize, n, target, sizes);
    const curves = enumerateCompositionCurves(ast, groupIds, deckSize, sizes);
    const split = pickMinimalVectors(curves, groupIds, n, target);

    expect(split.bestP).toBeCloseTo(monolithic.bestP, 10);
    const norm = (vs: typeof split.vectors) => vs.map((v) => groupIds.map((g) => v[g]).join(',')).sort();
    expect(norm(split.vectors)).toEqual(norm(monolithic.vectors));
  });

  it('the SAME cached curves correctly answer DIFFERENT target/n queries without re-enumerating', () => {
    const ast = parseQuery('land>=1 & ramp>=1', resolve);
    const groupIds = ['g0', 'g1'];
    const sizes = { g0: 4, g1: 3 };
    const curves = enumerateCompositionCurves(ast, groupIds, 40, sizes);

    const at90 = pickMinimalVectors(curves, groupIds, 10, 0.9);
    const at50 = pickMinimalVectors(curves, groupIds, 10, 0.5);
    const atTurn5 = pickMinimalVectors(curves, groupIds, 5, 0.9);

    // cross-check each against the monolithic function to confirm the cached
    // curves genuinely support arbitrary re-querying, not just the first case
    expect(at90.bestP).toBeCloseTo(generalMinimalVectors(ast, groupIds, 40, 10, 0.9, sizes).bestP, 10);
    expect(at50.vectors.length).toBeGreaterThan(0);
    expect(atTurn5.bestP).toBeCloseTo(generalMinimalVectors(ast, groupIds, 40, 5, 0.9, sizes).bestP, 10);
  });

  it('enumerateCompositionCurves throws the same SearchTooLargeError cases as the monolithic function', () => {
    const ast = parseQuery('!land>=4', resolve);
    expect(() => enumerateCompositionCurves(ast, ['g0', 'g1'], 1000, { g0: 100, g1: 100 }))
      .toThrow(SearchTooLargeError);
  });

  it('pickMinimalVectors never calls evaluate() -- pure array scan (structural: no Expr/Sizes params at all)', () => {
    // enforced by the type signature itself (no ast/baseSizes parameters),
    // but assert it runs fast even for a large pre-computed curve set as a
    // sanity check that nothing sneaks in expensive work.
    const ast = parseQuery('land>=1 & ramp>=1', resolve);
    const groupIds = ['g0', 'g1'];
    const curves = enumerateCompositionCurves(ast, groupIds, 40, { g0: 4, g1: 3 });
    const start = performance.now();
    for (let i = 0; i < 50; i++) pickMinimalVectors(curves, groupIds, 10, 0.5 + i * 0.001);
    expect(performance.now() - start).toBeLessThan(50); // 50 re-queries, should be near-instant
  });
});
