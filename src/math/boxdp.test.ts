import { describe, it, expect } from 'vitest';
import { boxCurve, type Constraint } from './boxdp';
import { bruteCurve } from './brute';
import { sfAtLeast } from './hyper';

function expectCurvesClose(a: Float64Array, b: Float64Array): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(a[i]!).toBeCloseTo(b[i]!, 11);
}

describe('boxCurve', () => {
  it('reduces to the univariate case for a single group', () => {
    const N = 40, K = 4;
    const c = boxCurve(N, [{ K, lo: 2, hi: K }]);
    for (let n = 0; n <= N; n++) expect(c[n]!).toBeCloseTo(sfAtLeast(N, K, n, 2), 12);
  });

  it('matches brute-force enumeration, 3 groups, mixed intervals', () => {
    const N = 18;
    const cases: Constraint[][] = [
      [{ K: 3, lo: 1, hi: 3 }, { K: 2, lo: 1, hi: 2 }],
      [{ K: 4, lo: 2, hi: 2 }, { K: 3, lo: 0, hi: 1 }],
      [{ K: 3, lo: 1, hi: 3 }, { K: 3, lo: 1, hi: 3 }, { K: 2, lo: 1, hi: 2 }],
      [{ K: 5, lo: 0, hi: 0 }],
      [{ K: 6, lo: 3, hi: 4 }, { K: 2, lo: 0, hi: 2 }],
    ];
    for (const cs of cases) {
      const sizes = cs.map((c) => c.K);
      const ref = bruteCurve(N, sizes, (counts) =>
        cs.every((c, i) => counts[i]! >= c.lo && counts[i]! <= c.hi));
      expectCurvesClose(boxCurve(N, cs), ref);
    }
  });

  it('an empty constraint list is the certain event', () => {
    const c = boxCurve(30, []);
    for (const p of c) expect(p).toBeCloseTo(1, 12);
  });

  it('an unsatisfiable interval is impossible everywhere', () => {
    const c = boxCurve(30, [{ K: 2, lo: 3, hi: 5 }]);
    for (const p of c) expect(p).toBe(0);
  });

  it('"at least" boxes are monotone in n and reach certainty at n=N', () => {
    const c = boxCurve(40, [{ K: 4, lo: 1, hi: 4 }, { K: 3, lo: 1, hi: 3 }]);
    for (let n = 1; n < c.length; n++) expect(c[n]!).toBeGreaterThanOrEqual(c[n - 1]! - 1e-15);
    expect(c[40]!).toBeCloseTo(1, 12);
  });

  it('an upper-bounded box is NOT monotone — it peaks then falls', () => {
    // "exactly one copy of a 4-of"
    const c = boxCurve(40, [{ K: 4, lo: 1, hi: 1 }]);
    let argmax = 0;
    for (let n = 0; n < c.length; n++) if (c[n]! > c[argmax]!) argmax = n;
    expect(argmax).toBeGreaterThan(0);
    expect(argmax).toBeLessThan(40);
    expect(c[40]!).toBeCloseTo(0, 12); // draw the deck, you see all 4
  });

  it('handles a full-deck group and a zero-size group', () => {
    expectCurvesClose(
      boxCurve(10, [{ K: 10, lo: 0, hi: 10 }]),
      new Float64Array(11).fill(1),
    );
    const z = boxCurve(10, [{ K: 0, lo: 0, hi: 0 }]);
    for (const p of z) expect(p).toBeCloseTo(1, 12);
  });

  it('rejects groups larger than the deck', () => {
    expect(() => boxCurve(10, [{ K: 8, lo: 1, hi: 8 }, { K: 5, lo: 1, hi: 5 }])).toThrow();
  });
});
