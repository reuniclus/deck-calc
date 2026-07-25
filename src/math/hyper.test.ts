import { describe, it, expect } from 'vitest';
import { pmf, cdf, sfAtLeast, between, support } from './hyper';
import { sfAtLeastExact, binomBig } from './exact';
import { binom, lnC } from './lnfact';

const REL = 1e-12;

describe('lnfact', () => {
  it('matches exact binomials', () => {
    for (const [n, k] of [[10, 3], [40, 7], [52, 5], [100, 50], [250, 3]] as const) {
      expect(binom(n, k)).toBeCloseTo(Number(binomBig(n, k)), -Math.log10(Number(binomBig(n, k)) * REL));
    }
  });
  it('is zero outside range', () => {
    expect(lnC(5, 6)).toBe(-Infinity);
    expect(binom(5, -1)).toBe(0);
  });
});

describe('hyper', () => {
  it('pmf sums to 1 over the support', () => {
    for (const [N, K, n] of [[40, 4, 7], [60, 12, 5], [99, 1, 99], [20, 20, 10]] as const) {
      const [lo, hi] = support(N, K, n);
      let s = 0;
      for (let x = lo; x <= hi; x++) s += pmf(N, K, n, x);
      expect(s).toBeCloseTo(1, 12);
    }
  });

  it('sfAtLeast matches the BigInt oracle', () => {
    for (const N of [12, 40, 60]) {
      for (const K of [0, 1, 3, 8]) {
        if (K > N) continue;
        for (const n of [0, 1, 5, 7, N]) {
          for (const k of [0, 1, 2, 3]) {
            expect(sfAtLeast(N, K, n, k)).toBeCloseTo(sfAtLeastExact(N, K, n, k), 12);
          }
        }
      }
    }
  });

  it('is monotone nondecreasing in n', () => {
    let prev = -1;
    for (let n = 0; n <= 40; n++) {
      const p = sfAtLeast(40, 4, n, 1);
      expect(p).toBeGreaterThanOrEqual(prev - 1e-15);
      prev = p;
    }
  });

  it('is monotone nondecreasing in K', () => {
    let prev = -1;
    for (let K = 0; K <= 40; K++) {
      const p = sfAtLeast(40, K, 7, 1);
      expect(p).toBeGreaterThanOrEqual(prev - 1e-15);
      prev = p;
    }
  });

  it('handles degenerate inputs', () => {
    expect(sfAtLeast(40, 4, 7, 0)).toBe(1);   // "at least zero" is certain
    expect(sfAtLeast(40, 4, 7, 5)).toBe(0);   // more than exist
    expect(sfAtLeast(40, 0, 7, 1)).toBe(0);   // empty group
    expect(sfAtLeast(40, 4, 0, 1)).toBe(0);   // no draws
    expect(sfAtLeast(40, 4, 40, 4)).toBeCloseTo(1, 12); // whole deck drawn
    expect(cdf(40, 4, 7, 4)).toBeCloseTo(1, 12);
  });

  it('between is consistent with the tails', () => {
    expect(between(40, 4, 7, 0, 4)).toBeCloseTo(1, 12);
    expect(between(40, 4, 7, 1, 1)).toBeCloseTo(pmf(40, 4, 7, 1), 12);
  });

  it('rejects impossible parameters', () => {
    expect(() => support(40, 41, 7)).toThrow();
    expect(() => support(40, 4, 41)).toThrow();
    expect(() => support(40, 4, -1)).toThrow();
  });
});
