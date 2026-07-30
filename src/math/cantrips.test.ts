import { describe, it, expect } from 'vitest';
import {
  dilutedResourceCount, cantripSuccessRate, marginalValuePerCopy, copiesNeededForTarget, successGivenDrawnVsNot,
  bestDilutionChoice, marginalValuePerCopyAutoDilute, copiesNeededForTargetAutoDilute,
} from './cantrips';
import { evaluate } from './evaluate';
import { normalize } from './normalize';
import { parseQuery } from './parse';

const resolve = (n: string) => ({ wincon: 'g0' }[n.toLowerCase()] ?? null);
const ast = parseQuery('wincon>=1', resolve);

describe('dilutedResourceCount', () => {
  it('cuts from filler first -- untouched while cantrips fit within Others', () => {
    expect(dilutedResourceCount(8, 12, 0)).toBe(8);
    expect(dilutedResourceCount(8, 12, 10)).toBe(8);
    expect(dilutedResourceCount(8, 12, 12)).toBe(8);
  });

  it('cuts into the resource once filler is exhausted, 1:1 beyond that point', () => {
    expect(dilutedResourceCount(8, 12, 13)).toBe(7);
    expect(dilutedResourceCount(8, 12, 15)).toBe(5);
    expect(dilutedResourceCount(8, 12, 20)).toBe(0); // clamped, never negative
  });
});

describe('cantripSuccessRate', () => {
  it('at count=0, reduces EXACTLY to the raw curve (no cantrips, no shift)', () => {
    const sizes = { g0: 8 };
    const dnf = normalize(ast, sizes);
    const raw = evaluate(40, sizes, dnf).curve[7]!;
    const withZero = cantripSuccessRate(dnf, sizes, 40, 7, 12, 'g0', [{ count: 3, bonus: 2 }].map((e) => ({ ...e, count: 0 })));
    expect(withZero).toBeCloseTo(raw, 10);
  });

  it('reproduces the exact numerically-confirmed dilution curve from the original design discussion (40-card deck, 8-copy wincon, 12 filler, bonus=2): smooth rise 0->12, sharp decline past it', () => {
    const sizes = { g0: 8 };
    const dnf = normalize(ast, sizes);
    const at = (cantrips: number) => cantripSuccessRate(dnf, sizes, 40, 9, 12, 'g0', [{ count: cantrips, bonus: 2 }]);

    // Original ad-hoc measurement: 0->12 rises 89.7%->97.6%; 14->18 falls
    // 94.9%->87.8%->67.4%. Re-derived here as a permanent, exact test
    // rather than a one-off script result.
    expect(at(0) * 100).toBeCloseTo(89.7, 0);
    expect(at(12) * 100).toBeCloseTo(97.6, 0);
    expect(at(14) * 100).toBeCloseTo(94.9, 0);
    expect(at(16) * 100).toBeCloseTo(87.8, 0);
    expect(at(18) * 100).toBeCloseTo(67.4, 0);

    // The actual shape that motivated this whole feature: a real peak,
    // not monotone improvement forever.
    expect(at(12)).toBeGreaterThan(at(18));
  });

  it('a genuinely independent brute-force cross-check for TWO simultaneous effect types (not reusing any of cantripSuccessRate\'s own helpers)', () => {
    const sizes = { g0: 6 };
    const dnf = normalize(ast, sizes);
    const deckSize = 30, cardsSeenByT = 8, othersCount = 10;
    const effectA = { count: 3, bonus: 1 }; // e.g. "draw 1"
    const effectB = { count: 2, bonus: 3 }; // e.g. "look 3 keep 1"
    const totalCantrips = effectA.count + effectB.count;
    const dilutedWincon = Math.max(0, 6 - Math.max(0, totalCantrips - othersCount));
    const dilutedSizes = { g0: dilutedWincon };
    const dilutedDnf = normalize(ast, dilutedSizes);

    function chooseBF(n: number, k: number): number {
      if (k < 0 || k > n) return 0;
      let r = 1;
      for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
      return r;
    }
    function hyperBF(N: number, K: number, n: number, x: number): number {
      return (chooseBF(K, x) * chooseBF(N - K, n - x)) / chooseBF(N, n);
    }

    let expected = 0;
    for (let ka = 0; ka <= Math.min(effectA.count, cardsSeenByT); ka++) {
      const pa = hyperBF(deckSize, effectA.count, cardsSeenByT, ka);
      if (pa <= 0) continue;
      for (let kb = 0; kb <= Math.min(effectB.count, cardsSeenByT); kb++) {
        const pb = hyperBF(deckSize, effectB.count, cardsSeenByT, kb);
        if (pb <= 0) continue;
        const effectiveN = Math.min(cardsSeenByT + ka * effectA.bonus + kb * effectB.bonus, deckSize);
        const p = evaluate(deckSize, dilutedSizes, dilutedDnf).curve[effectiveN]!;
        expected += pa * pb * p;
      }
    }

    const actual = cantripSuccessRate(dnf, sizes, deckSize, cardsSeenByT, othersCount, 'g0', [effectA, effectB]);
    expect(actual).toBeCloseTo(expected, 8);
  });

  it('an effect with count=0 in a mixed list contributes nothing (skipped, not a free dimension)', () => {
    const sizes = { g0: 8 };
    const dnf = normalize(ast, sizes);
    const withDead = cantripSuccessRate(dnf, sizes, 40, 9, 12, 'g0', [{ count: 5, bonus: 2 }, { count: 0, bonus: 99 }]);
    const withoutDead = cantripSuccessRate(dnf, sizes, 40, 9, 12, 'g0', [{ count: 5, bonus: 2 }]);
    expect(withDead).toBeCloseTo(withoutDead, 10);
  });
});

describe('marginalValuePerCopy', () => {
  it('telescopes to (P(4)-P(0))/4 exactly, matching direct calls to cantripSuccessRate', () => {
    const sizes = { g0: 8 };
    const dnf = normalize(ast, sizes);
    const p0 = cantripSuccessRate(dnf, sizes, 40, 9, 12, 'g0', [{ count: 0, bonus: 2 }]);
    const p4 = cantripSuccessRate(dnf, sizes, 40, 9, 12, 'g0', [{ count: 4, bonus: 2 }]);
    const marginal = marginalValuePerCopy(dnf, sizes, 40, 9, 12, 'g0', 2);
    expect(marginal).toBeCloseTo((p4 - p0) / 4, 10);
  });

  it('a bigger bonus gives a bigger (or equal) marginal value, all else equal', () => {
    const sizes = { g0: 8 };
    const dnf = normalize(ast, sizes);
    const small = marginalValuePerCopy(dnf, sizes, 40, 9, 12, 'g0', 1);
    const big = marginalValuePerCopy(dnf, sizes, 40, 9, 12, 'g0', 3);
    expect(big).toBeGreaterThanOrEqual(small - 1e-12);
  });

  it('which group absorbs dilution genuinely matters -- but only once cantrip count actually exceeds Others (a large Others pool means the choice is a no-op at small counts, confirmed directly, not assumed)', () => {
    const resolve2 = (n: string) => ({ a: 'g0', b: 'g1' }[n.toLowerCase()] ?? null);
    const ast2 = parseQuery('a>=1 & b>=1', resolve2);
    const sizes2 = { g0: 4, g1: 3 };
    const dnf2 = normalize(ast2, sizes2);

    // Large Others pool (33): dilution never reaches either group within
    // 0-4 copies, so the choice of WHICH group is a genuine no-op.
    const bigOthersA = marginalValuePerCopy(dnf2, sizes2, 40, 9, 33, 'g0', 1);
    const bigOthersB = marginalValuePerCopy(dnf2, sizes2, 40, 9, 33, 'g1', 1);
    expect(bigOthersA).toBeCloseTo(bigOthersB, 10);

    // Small Others pool (3): dilution reaches a group well within 0-4
    // copies, so which group is chosen genuinely changes the result.
    const smallOthersA = marginalValuePerCopy(dnf2, sizes2, 10, 4, 3, 'g0', 1);
    const smallOthersB = marginalValuePerCopy(dnf2, sizes2, 10, 4, 3, 'g1', 1);
    expect(Math.abs(smallOthersA - smallOthersB)).toBeGreaterThan(1e-4);
  });
});

describe('copiesNeededForTarget', () => {
  it('finds a count that actually achieves the target, and count-1 does not', () => {
    const sizes = { g0: 8 };
    const dnf = normalize(ast, sizes);
    const target = 0.9;
    const needed = copiesNeededForTarget(dnf, sizes, 40, 9, 12, 'g0', 2, target, 30);
    expect(needed).not.toBeNull();
    const achieved = cantripSuccessRate(dnf, sizes, 40, 9, 12, 'g0', [{ count: needed!, bonus: 2 }]);
    expect(achieved).toBeGreaterThanOrEqual(target - 1e-9);
    if (needed! > 0) {
      const oneLess = cantripSuccessRate(dnf, sizes, 40, 9, 12, 'g0', [{ count: needed! - 1, bonus: 2 }]);
      expect(oneLess).toBeLessThan(target);
    }
  });

  it('returns null (not a wrong answer) when the target is unreachable within maxSearch', () => {
    const sizes = { g0: 1 };
    const dnf = normalize(ast, sizes);
    const needed = copiesNeededForTarget(dnf, sizes, 40, 1, 0, 'g0', 1, 0.9999999, 2);
    expect(needed).toBeNull();
  });
});

describe('successGivenDrawnVsNot', () => {
  it('the weighted combination of givenDrawn/givenNotDrawn reproduces the overall cantripSuccessRate exactly', () => {
    const sizes = { g0: 8 };
    const dnf = normalize(ast, sizes);
    const count = 5, bonus = 2;
    const { givenDrawn, givenNotDrawn, pDrawn } = successGivenDrawnVsNot(dnf, sizes, 40, 9, 12, 'g0', count, bonus);
    const reconstructed = pDrawn * givenDrawn + (1 - pDrawn) * givenNotDrawn;
    const overall = cantripSuccessRate(dnf, sizes, 40, 9, 12, 'g0', [{ count, bonus }]);
    expect(reconstructed).toBeCloseTo(overall, 8);
  });

  it('drawing a copy of the effect never hurts -- givenDrawn >= givenNotDrawn for a monotone query', () => {
    const sizes = { g0: 8 };
    const dnf = normalize(ast, sizes);
    const { givenDrawn, givenNotDrawn } = successGivenDrawnVsNot(dnf, sizes, 40, 9, 12, 'g0', 5, 2);
    expect(givenDrawn).toBeGreaterThanOrEqual(givenNotDrawn - 1e-12);
  });

  it('with count=0, givenNotDrawn matches the raw curve exactly and pDrawn is 0', () => {
    const sizes = { g0: 8 };
    const dnf = normalize(ast, sizes);
    const { givenNotDrawn, pDrawn } = successGivenDrawnVsNot(dnf, sizes, 40, 9, 12, 'g0', 0, 2);
    const raw = evaluate(40, sizes, dnf).curve[9]!;
    expect(givenNotDrawn).toBeCloseTo(raw, 10);
    expect(pDrawn).toBe(0);
  });

  it('REGRESSION: a non-integer bonus (e.g. a pooled average of several effect types) must not silently produce a wrong near-zero result. Float64Array indexed with a non-integer returns undefined, and a careless "?? 0" fallback turns that into a WRONG zero rather than an error -- confirmed directly as the actual failure mode before fixing it.', () => {
    const sizes = { g0: 4, g1: 3 };
    const resolve2 = (n: string) => ({ a: 'g0', b: 'g1' }[n.toLowerCase()] ?? null);
    const ast2 = parseQuery('a>=1 & b>=1', resolve2);
    const dnf2 = normalize(ast2, sizes);
    // 6 copies at bonus=3, 1 copy at bonus=4 pooled into one average effect:
    // avgBonus = (6*3+1*4)/7 = 22/7 = 3.142857... -- deliberately non-integer.
    const avgBonus = (6 * 3 + 1 * 4) / 7;
    const { givenDrawn, givenNotDrawn } = successGivenDrawnVsNot(dnf2, sizes, 40, 9, 33, 'g0', 7, avgBonus);
    // Drawing a copy must never make things drastically WORSE than not
    // drawing one, for a monotone query -- the bug produced givenDrawn
    // near 0.0000022 against a givenNotDrawn of 0.34, which is exactly
    // backwards.
    expect(givenDrawn).toBeGreaterThanOrEqual(givenNotDrawn - 1e-9);
    // Sanity: neither value should be a suspicious near-zero given a
    // reasonably strong setup (7 copies, bonus >3, on a 2-group AND query).
    expect(givenDrawn).toBeGreaterThan(0.1);
  });

  it('REGRESSION: the same non-integer-bonus case in cantripSuccessRate (the joint multi-effect path) also must not silently zero out', () => {
    const sizes = { g0: 4, g1: 3 };
    const resolve2 = (n: string) => ({ a: 'g0', b: 'g1' }[n.toLowerCase()] ?? null);
    const ast2 = parseQuery('a>=1 & b>=1', resolve2);
    const dnf2 = normalize(ast2, sizes);
    const p = cantripSuccessRate(dnf2, sizes, 40, 9, 33, 'g0', [{ count: 6, bonus: 3.5 }, { count: 1, bonus: 4.25 }]);
    const withoutCantrips = cantripSuccessRate(dnf2, sizes, 40, 9, 33, 'g0', []);
    // More cards examined (even at fractional bonus) should never make
    // things drastically worse than running no cantrips at all.
    expect(p).toBeGreaterThanOrEqual(withoutCantrips - 1e-9);
  });
});

describe('bestDilutionChoice', () => {
  it('in the simple case (both groups needed via AND), picks whichever choice is at least as good -- ties are fine, this just confirms it does not throw or pick something worse', () => {
    const resolve2 = (n: string) => ({ a: 'g0', b: 'g1' }[n.toLowerCase()] ?? null);
    const ast2 = parseQuery('a>=1 & b>=1', resolve2);
    const sizes2 = { g0: 4, g1: 3 };
    const dnf2 = normalize(ast2, sizes2);
    const { group, rate } = bestDilutionChoice(dnf2, sizes2, 10, 4, 3, ['g0', 'g1'], [{ count: 5, bonus: 2 }]);
    expect(['g0', 'g1']).toContain(group);
    const g0Rate = cantripSuccessRate(dnf2, sizes2, 10, 4, 3, 'g0', [{ count: 5, bonus: 2 }]);
    const g1Rate = cantripSuccessRate(dnf2, sizes2, 10, 4, 3, 'g1', [{ count: 5, bonus: 2 }]);
    expect(rate).toBeGreaterThanOrEqual(Math.max(g0Rate, g1Rate) - 1e-12);
  });

  it('REAL counterexample: a naive "most populous group" heuristic would pick WRONG here -- an OR query where the more-populous group (15 copies) is actually the harder-to-satisfy bottleneck (needs >=3) vs. the less-populous group (2 copies, needs only >=1). bestDilutionChoice correctly picks the LESS populous group, and it is measurably better, not just different.', () => {
    const resolve2 = (n: string) => ({ a: 'g0', b: 'g1' }[n.toLowerCase()] ?? null);
    const ast2 = parseQuery('a>=3 | b>=1', resolve2);
    const sizes2 = { g0: 15, g1: 2 };
    const dnf2 = normalize(ast2, sizes2);
    const deckSize = 40, cardsSeenByT = 9, othersCount = 5;
    const effects = [{ count: 8, bonus: 2 }];

    const { group } = bestDilutionChoice(dnf2, sizes2, deckSize, cardsSeenByT, othersCount, ['g0', 'g1'], effects);
    expect(group).toBe('g1'); // NOT g0, despite g0 having far more raw copies (15 vs 2)

    const withNaivePick = cantripSuccessRate(dnf2, sizes2, deckSize, cardsSeenByT, othersCount, 'g0', effects);
    const withActualBest = cantripSuccessRate(dnf2, sizes2, deckSize, cardsSeenByT, othersCount, 'g1', effects);
    expect(withActualBest).toBeGreaterThan(withNaivePick); // measurably better, not a coin flip
  });
});

describe('marginalValuePerCopyAutoDilute / copiesNeededForTargetAutoDilute', () => {
  it('auto-dilute marginal value is never worse than picking either single fixed group', () => {
    const resolve2 = (n: string) => ({ a: 'g0', b: 'g1' }[n.toLowerCase()] ?? null);
    const ast2 = parseQuery('a>=1 & b>=1', resolve2);
    const sizes2 = { g0: 4, g1: 3 };
    const dnf2 = normalize(ast2, sizes2);
    const auto = marginalValuePerCopyAutoDilute(dnf2, sizes2, 10, 4, 3, ['g0', 'g1'], 2);
    const fixedG0 = marginalValuePerCopy(dnf2, sizes2, 10, 4, 3, 'g0', 2);
    const fixedG1 = marginalValuePerCopy(dnf2, sizes2, 10, 4, 3, 'g1', 2);
    expect(auto).toBeGreaterThanOrEqual(Math.max(fixedG0, fixedG1) - 1e-9);
  });

  it('auto-dilute copies-needed never needs MORE copies than a fixed (fortuitously optimal) choice would', () => {
    const sizes = { g0: 8 };
    const dnf = normalize(ast, sizes);
    const autoNeeded = copiesNeededForTargetAutoDilute(dnf, sizes, 40, 9, 12, ['g0'], 2, 0.9, 30);
    const fixedNeeded = copiesNeededForTarget(dnf, sizes, 40, 9, 12, 'g0', 2, 0.9, 30);
    expect(autoNeeded).not.toBeNull();
    expect(autoNeeded!).toBeLessThanOrEqual(fixedNeeded!);
  });

  it('re-optimizing at each step (auto-dilute) can find a target reachable in FEWER copies than fixing one group upfront, in the OR counterexample scenario', () => {
    const resolve2 = (n: string) => ({ a: 'g0', b: 'g1' }[n.toLowerCase()] ?? null);
    const ast2 = parseQuery('a>=3 | b>=1', resolve2);
    const sizes2 = { g0: 15, g1: 2 };
    const dnf2 = normalize(ast2, sizes2);
    const auto = copiesNeededForTargetAutoDilute(dnf2, sizes2, 40, 9, 5, ['g0', 'g1'], 2, 0.92, 30);
    const fixedWorst = copiesNeededForTarget(dnf2, sizes2, 40, 9, 5, 'g0', 2, 0.92, 30);
    expect(auto).not.toBeNull();
    if (fixedWorst !== null) expect(auto!).toBeLessThanOrEqual(fixedWorst);
  });
});
