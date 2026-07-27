import { describe, it, expect } from 'vitest';
import { optimalMulliganStrategy, optimalMulliganCurve, MulliganTooLargeError } from './mulligan';
import { parseQuery } from './parse';
import { normalize } from './normalize';
import { evaluate } from './evaluate';

const resolve = (n: string) => ({ land: 'g0', blink: 'g0', ramp: 'g1', spell: 'g1' }[n.toLowerCase()] ?? null);

describe('optimalMulliganStrategy', () => {
  it('at 0 mulligans, bestP EXACTLY equals the existing curve at n=handSize+extraDraws (ties the new model to already-trusted math)', () => {
    const ast = parseQuery('land>=1', resolve);
    const sizes = { g0: 10 };
    const dnf = normalize(ast, sizes);
    const deckSize = 40, handSize = 7, extraDraws = 3; // turn ~4

    const { bestP, neverMulliganP } = optimalMulliganStrategy(dnf, sizes, deckSize, handSize, extraDraws, 0);
    const existingCurveValue = evaluate(deckSize, sizes, dnf).curve[handSize + extraDraws]!;

    expect(bestP).toBeCloseTo(existingCurveValue, 10);
    expect(neverMulliganP).toBeCloseTo(existingCurveValue, 10);
  });

  it('with mulligans allowed, bestP >= neverMulliganP always (optimal play can only help or be neutral, never hurt)', () => {
    const ast = parseQuery('land>=3', resolve);
    const sizes = { g0: 10 };
    const dnf = normalize(ast, sizes);
    const { bestP, neverMulliganP } = optimalMulliganStrategy(dnf, sizes, 40, 7, 5, 2);
    expect(bestP).toBeGreaterThanOrEqual(neverMulliganP - 1e-12);
  });

  it('more mulligans available never decreases bestP (monotone in mulligan count -- you can always just keep hand 1)', () => {
    const ast = parseQuery('land>=3', resolve);
    const sizes = { g0: 10 };
    const dnf = normalize(ast, sizes);
    const p0 = optimalMulliganStrategy(dnf, sizes, 40, 7, 5, 0).bestP;
    const p1 = optimalMulliganStrategy(dnf, sizes, 40, 7, 5, 1).bestP;
    const p2 = optimalMulliganStrategy(dnf, sizes, 40, 7, 5, 2).bestP;
    expect(p1).toBeGreaterThanOrEqual(p0 - 1e-12);
    expect(p2).toBeGreaterThanOrEqual(p1 - 1e-12);
  });

  it('bestP is STRICTLY GREATER than the naive independent-attempts formula 1-(1-p)^(M+1) -- confirmed as a real effect, not a bug: a failing hand, by definition, drew FEWER lands than average, so the deck LEFT BEHIND is enriched in lands, making the next attempt genuinely easier than a fresh independent look would be. The naive formula assumes reshuffling (real London-rule semantics); our single-continuous-deck model does not, so it should NOT match, and should be BETTER.', () => {
    const ast = parseQuery('land>=3', resolve);
    const sizes = { g0: 10 };
    const dnf = normalize(ast, sizes);
    const deckSize = 40, handSize = 7, extraDraws = 0, M = 2;

    const p = evaluate(deckSize, sizes, dnf).curve[handSize]!;
    const naiveIndependentFormula = 1 - Math.pow(1 - p, M + 1);
    const { bestP } = optimalMulliganStrategy(dnf, sizes, deckSize, handSize, extraDraws, M);
    expect(bestP).toBeGreaterThan(naiveIndependentFormula);
  });

  it('strategy rows sum their probabilities to 1 (every possible hand is accounted for)', () => {
    const ast = parseQuery('land>=2', resolve);
    const sizes = { g0: 8 };
    const dnf = normalize(ast, sizes);
    const { strategy } = optimalMulliganStrategy(dnf, sizes, 40, 7, 3, 1);
    const totalP = strategy.reduce((s, r) => s + r.probability, 0);
    expect(totalP).toBeCloseTo(1, 8);
  });

  it('a hand that already fully satisfies the query gets shouldKeep=true and keepP=1', () => {
    const ast = parseQuery('land>=1', resolve);
    const sizes = { g0: 30 }; // very high land count -- most hands will have >=1
    const dnf = normalize(ast, sizes);
    const { strategy } = optimalMulliganStrategy(dnf, sizes, 40, 7, 0, 1);
    const satisfyingRow = strategy.find((r) => r.hand.g0! >= 1);
    expect(satisfyingRow).toBeTruthy();
    expect(satisfyingRow!.keepP).toBeCloseTo(1, 10);
    expect(satisfyingRow!.shouldKeep).toBe(true);
  });

  it('a hand-composition-space that is too large throws MulliganTooLargeError rather than hanging', () => {
    const ast = parseQuery('a>=1 & b>=1 & c>=1 & d>=1 & e>=1', (n) =>
      ({ a: 'g0', b: 'g1', c: 'g2', d: 'g3', e: 'g4' }[n.toLowerCase()] ?? null));
    const sizes = { g0: 5, g1: 5, g2: 5, g3: 5, g4: 5 };
    const dnf = normalize(ast, sizes);
    expect(() => optimalMulliganStrategy(dnf, sizes, 40, 7, 3, 2)).toThrow(MulliganTooLargeError);
  });

  it('the multi-group case: cross-checked directly against a hand-rolled brute-force over 1 mulligan (2 groups, deliberately small deck for tractability)', () => {
    const ast = parseQuery('land>=1 & ramp>=1', resolve);
    const sizes = { g0: 4, g1: 3 };
    const dnf = normalize(ast, sizes);
    const deckSize = 15, handSize = 7, extraDraws = 0, M = 1;

    const { bestP } = optimalMulliganStrategy(dnf, sizes, deckSize, handSize, extraDraws, M);

    // Independent brute-force: enumerate every possible (hand1, hand2) pair
    // directly via combinatorics, without reusing ANY of mulligan.ts's own
    // helper functions, as a genuinely separate check.
    function chooseBF(n: number, k: number): number {
      if (k < 0 || k > n) return 0;
      let r = 1;
      for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
      return r;
    }
    let total = 0;
    for (let a1 = 0; a1 <= Math.min(4, 7); a1++) {
      for (let b1 = 0; b1 <= Math.min(3, 7 - a1); b1++) {
        const other1 = 7 - a1 - b1;
        const otherTotal1 = deckSize - 4 - 3;
        if (other1 > otherTotal1 || other1 < 0) continue;
        const p1 = (chooseBF(4, a1) * chooseBF(3, b1) * chooseBF(otherTotal1, other1)) / chooseBF(deckSize, 7);
        if (p1 <= 0) continue;
        const satisfies1 = a1 >= 1 && b1 >= 1;
        if (satisfies1) { total += p1 * 1; continue; }

        // mulligan: remaining deck after removing hand1
        const remA = 4 - a1, remB = 3 - b1, remDeck = deckSize - 7;
        let bestMulligan = 0;
        for (let a2 = 0; a2 <= Math.min(remA, 7); a2++) {
          for (let b2 = 0; b2 <= Math.min(remB, 7 - a2); b2++) {
            const other2 = 7 - a2 - b2;
            const otherTotal2 = remDeck - remA - remB;
            if (other2 > otherTotal2 || other2 < 0) continue;
            const p2 = (chooseBF(remA, a2) * chooseBF(remB, b2) * chooseBF(otherTotal2, other2)) / chooseBF(remDeck, 7);
            if (p2 <= 0) continue;
            const satisfies2 = a2 >= 1 && b2 >= 1;
            bestMulligan += p2 * (satisfies2 ? 1 : 0);
          }
        }
        total += p1 * Math.max(0, bestMulligan); // 0 = value of keeping hand1 anyway (fails)
      }
    }
    expect(bestP).toBeCloseTo(total, 8);
  });

  it('the flagged edge case: mulligans deep enough that the deck runs out of cards for another full hand -- degrades safely to 0 for that branch, not NaN/crash', () => {
    const ast = parseQuery('land>=3', resolve);
    const sizes = { g0: 5 };
    const dnf = normalize(ast, sizes);
    // deckSize=10, handSize=7: only ONE full hand fits at all (10-7=3 left,
    // not enough for a second 7-card look) -- exercises exactly the
    // "opening hand + mulligans exceed deck size" case flagged as a real
    // but rare edge case.
    const result = optimalMulliganStrategy(dnf, sizes, 10, 7, 0, 2);
    expect(Number.isFinite(result.bestP)).toBe(true);
    expect(result.bestP).toBeGreaterThanOrEqual(0);
    expect(result.bestP).toBeLessThanOrEqual(1);
    // with no room for even a single mulligan, bestP should match neverMulliganP
    // exactly (every "mulligan" option degrades to a guaranteed-0 branch,
    // so the max is always just keepP)
    expect(result.bestP).toBeCloseTo(result.neverMulliganP, 10);
  });
});

describe('optimalMulliganCurve (whole-curve version, for the chart/table/grid)', () => {
  it('matches optimalMulliganStrategy EXACTLY at every corresponding extraDraws point (cross-validates the bulk computation against the already-proven scalar one)', () => {
    const ast = parseQuery('land>=1 & ramp>=1', resolve);
    const sizes = { g0: 4, g1: 3 };
    const dnf = normalize(ast, sizes);
    const deckSize = 20, handSize = 7, M = 1;

    const { bestCurve, neverMulliganCurve } = optimalMulliganCurve(dnf, sizes, deckSize, handSize, M);
    for (let extraDraws = 0; extraDraws <= deckSize - handSize; extraDraws += 3) {
      const scalar = optimalMulliganStrategy(dnf, sizes, deckSize, handSize, extraDraws, M);
      expect(bestCurve[extraDraws]).toBeCloseTo(scalar.bestP, 10);
      expect(neverMulliganCurve[extraDraws]).toBeCloseTo(scalar.neverMulliganP, 10);
    }
  });

  it('at 0 mulligans, neverMulliganCurve and bestCurve are IDENTICAL to each other and to the raw evaluate() curve shifted by handSize', () => {
    const ast = parseQuery('land>=2', resolve);
    const sizes = { g0: 8 };
    const dnf = normalize(ast, sizes);
    const deckSize = 40, handSize = 7;

    const { bestCurve, neverMulliganCurve } = optimalMulliganCurve(dnf, sizes, deckSize, handSize, 0);
    const rawCurve = evaluate(deckSize, sizes, dnf).curve;
    for (let extraDraws = 0; extraDraws <= deckSize - handSize; extraDraws++) {
      expect(bestCurve[extraDraws]).toBeCloseTo(neverMulliganCurve[extraDraws]!, 10);
      expect(bestCurve[extraDraws]).toBeCloseTo(rawCurve[handSize + extraDraws]!, 10);
    }
  });

  it('bestCurve >= neverMulliganCurve at every point, and is monotonically non-decreasing in extraDraws (more draws never hurts a monotone query)', () => {
    const ast = parseQuery('land>=3', resolve);
    const sizes = { g0: 10 };
    const dnf = normalize(ast, sizes);
    const { bestCurve, neverMulliganCurve } = optimalMulliganCurve(dnf, sizes, 40, 7, 2);
    for (let i = 0; i < bestCurve.length; i++) {
      expect(bestCurve[i]!).toBeGreaterThanOrEqual(neverMulliganCurve[i]! - 1e-12);
      if (i > 0) expect(bestCurve[i]!).toBeGreaterThanOrEqual(bestCurve[i - 1]! - 1e-12);
    }
  });
});
