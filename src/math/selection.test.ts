import { describe, expect, it } from 'vitest';
import { evaluate } from './evaluate';
import { bruteSelectionP } from './bruteSelection';
import {
  assertDrawShaped, drawEffect, exactDrawCurve, exactDrawCurveUnsplit, impulseEffect,
  scryEffect, slotDistribution, UnsupportedSelectionError,
} from './selection';
import type { Dnf } from './expr';

const atLeast = (t: number, K: number): Dnf => ({ clauses: [{ A: { lo: t, hi: K } }], monotone: true });

describe('exactDrawCurve vs brute force', () => {
  // Every case here is the DP against a full play-out of every distinct deck
  // ordering with the real card mechanics -- an independent implementation
  // sharing no hypergeometric code with the thing it checks.
  const configs: Array<[number, number, number, number]> = [
    [12, 3, 2, 2],
    [12, 3, 2, 1],
    [11, 2, 3, 2],
    [10, 4, 2, 3],
  ];
  for (const [N, A, C, E] of configs) {
    for (const t of [1, 2]) {
      it(`N=${N} A=${A} copies=${C} examined=${E}, needs A>=${t}`, () => {
        const dnf = atLeast(t, A);
        const dp = exactDrawCurve(dnf, { A }, N, C, E, 8);
        for (const n of [0, 1, 2, 3, 5, 7]) {
          const brute = bruteSelectionP(
            { A, C, '': N - A - C },
            n,
            { group: 'C', examined: E, keepMax: E, keptCostsDraw: false, nonKeptLeavesPool: true },
            { A: t },
          );
          expect(dp[n]!).toBeCloseTo(brute, 12);
        }
      });
    }
  }
});

describe('exactDrawCurve degenerate cases', () => {
  // The generalization has to SUBSUME the plain case, not sit beside it
  // (PLAN.md, correction 1): with no copies in the deck the DP must reproduce
  // evaluate() exactly, not merely closely.
  it('zero copies is an exact passthrough of evaluate()', () => {
    const dnf = atLeast(2, 8);
    const plain = evaluate(40, { A: 8 }, dnf).curve;
    const dp = exactDrawCurve(dnf, { A: 8 }, 40, 0, 3, 12);
    for (let n = 0; n <= 12; n++) expect(dp[n]!).toBe(plain[n]!);
  });

  it('examined=0 makes copies indistinguishable from filler', () => {
    const dnf = atLeast(1, 6);
    // An effect that examines nothing is just a dead card occupying a slot, so
    // the deck it lives in is the FULL deck (6/40 on the first draw), not the
    // deck with the copies removed (6/36). Wrote it the wrong way round first;
    // the DP was right and the expectation was wrong, which is the correct
    // direction for a check like this to fail.
    const plain = evaluate(40, { A: 6 }, dnf).curve;
    const dp = exactDrawCurve(dnf, { A: 6 }, 40, 4, 0, 10);
    for (let n = 0; n <= 10; n++) expect(dp[n]!).toBeCloseTo(plain[n]!, 12);
  });

  it('more copies never lowers a monotone query at fixed n', () => {
    const dnf = atLeast(2, 8);
    let prev = -1;
    for (const copies of [0, 2, 4, 6]) {
      const p = exactDrawCurve(dnf, { A: 8 }, 60, copies, 2, 10)[10]!;
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });

  it('is nondecreasing in draws', () => {
    const dp = exactDrawCurve(atLeast(2, 8), { A: 8 }, 60, 4, 3, 15);
    for (let n = 1; n <= 15; n++) expect(dp[n]!).toBeGreaterThanOrEqual(dp[n - 1]! - 1e-12);
  });
});

describe('the query-independent slot split', () => {
  // Splitting the slot DP out from the query evaluation is what makes a grid
  // sweep affordable (measured: 117ms cold, 11.5ms warm at 99 cards). It has
  // to be an exact restructuring, not an approximation of the inlined version.
  it('matches the inlined reference implementation', () => {
    const dnf: Dnf = { clauses: [{ A: { lo: 2, hi: 10 }, B: { lo: 1, hi: 6 } }], monotone: true };
    for (const [N, C, E] of [[40, 8, 3], [30, 5, 2]] as const) {
      const split = exactDrawCurve(dnf, { A: 10, B: 6 }, N, C, E, 15);
      const inlined = exactDrawCurveUnsplit(dnf, { A: 10, B: 6 }, N, C, E, 15);
      for (let n = 0; n <= 15; n++) expect(split[n]!).toBeCloseTo(inlined[n]!, 14);
    }
  });

  it('slot outcomes are a normalized distribution per draw count', () => {
    const slots = slotDistribution(40, 6, 3, 10);
    for (const outcomes of slots) {
      const mass = outcomes.reduce((s, o) => s + o.p, 0);
      expect(mass).toBeCloseTo(1, 12);
    }
  });

  it('seen cards never exceed scheduled draws plus every copy\'s window', () => {
    const examined = 3, copies = 6;
    const slots = slotDistribution(40, copies, examined, 10);
    slots.forEach((outcomes, n) => {
      for (const o of outcomes) {
        expect(o.seen).toBeGreaterThanOrEqual(Math.min(n, 40));
        expect(o.seen).toBeLessThanOrEqual(n + copies * examined);
      }
    });
  });
});

describe('unimplemented effect shapes fail loudly', () => {
  it('accepts draw-shaped effects', () => {
    expect(() => assertDrawShaped(drawEffect('C', 3))).not.toThrow();
  });
  it('rejects scry (kept cards cost draws)', () => {
    expect(() => assertDrawShaped(scryEffect('C', 3))).toThrow(UnsupportedSelectionError);
  });
  it('rejects impulse (keepMax below window size)', () => {
    expect(() => assertDrawShaped(impulseEffect('C', 3))).toThrow(UnsupportedSelectionError);
  });
});

describe('the rejected closed forms, pinned as wrong', () => {
  // Regression guard for the actual finding: the single-index closed forms are
  // not just imprecise, they are wrong by percentage points with a sign that
  // flips by threshold -- so nothing should quietly reintroduce one as an
  // optimization. Values from bruteSelection.ts (N=12, A=3, 2 copies, draw 2).
  it('flat "index the full curve at n + k*examined" is off by points', () => {
    const N = 12, A = 3, C = 2, E = 2;
    const full = evaluate(N, { A }, atLeast(1, A)).curve;
    const n = 3;
    // The flat form's own arithmetic, reproduced here rather than kept in
    // shipped code: sum over k of P(k copies among first n) * curve[n + k*E].
    const flat = [0, 1, 2].reduce((acc, k) => {
      const pk = [0.5454545454545454, 0.4090909090909091, 0.045454545454545456][k]!;
      return acc + pk * full[n + k * E]!;
    }, 0);
    const brute = bruteSelectionP(
      { A, C, '': N - A - C }, n,
      { group: 'C', examined: E, keepMax: E, keptCostsDraw: false, nonKeptLeavesPool: true },
      { A: 1 },
    );
    expect(brute - flat).toBeGreaterThan(0.03);
    expect(exactDrawCurve(atLeast(1, A), { A }, N, C, E, 8)[n]!).toBeCloseTo(brute, 12);
  });
});
