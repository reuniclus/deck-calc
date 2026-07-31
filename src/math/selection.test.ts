import { describe, expect, it } from 'vitest';
import { evaluate } from './evaluate';
import {
  bruteSelectionDnfP, bruteSelectionDnfUpperP, bruteSelectionP, bruteSelectionUpperP,
} from './bruteSelection';
import {
  assertDrawShaped, drawEffect, exactDrawCurve, exactDrawCurveUnsplit,
  exactScryCurveSingleGroup, exactSelectionCurveAnd, exactSelectionCurveDnf,
  exactSelectionCurveSingleGroup,
  impulseEffect, ponderEffect,
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

describe('all four effect shapes vs brute force', () => {
  // The brute force plays the no-shuffle policy and treats bottomed cards as
  // unreachable, matching the model's stated scope, so these are exact checks
  // rather than approximate ones.
  const configs: Array<[number, number, number, number]> = [[12, 3, 2, 2], [11, 2, 3, 2], [10, 4, 2, 3]];
  const shapes = (E: number) => [
    ['draw', drawEffect('C', E)],
    ['scry', scryEffect('C', E)],
    ['impulse', impulseEffect('C', E)],
    ['ponder (no shuffle)', { ...ponderEffect('C', E), canShuffle: false }],
  ] as const;

  for (const [N, A, C, E] of configs) {
    for (const t of [1, 2]) {
      for (const [name, eff] of shapes(E)) {
        it(`${name}: N=${N} A=${A} copies=${C} examined=${E}, needs A>=${t}`, () => {
          const dp = exactSelectionCurveSingleGroup(N, A, t, eff, C, 7);
          for (const n of [1, 2, 3, 5, 7]) {
            const brute = bruteSelectionP(
              { A, C, '': N - A - C }, n,
              {
                group: 'C', examined: eff.examined, keepMax: eff.keepMax,
                keptCostsDraw: eff.keptCostsDraw, nonKeptLeavesPool: eff.nonKeptLeavesPool,
              },
              { A: t },
            );
            expect(dp[n]!).toBeCloseTo(brute, 12);
          }
        });
      }
    }
  }
});

describe('independent derivations of the same numbers agree', () => {
  // exactDrawCurve is a slot DP with no group dimensions; the atomic-window
  // engine carries group state and enumerates whole windows. Two different
  // derivations, so agreement is evidence rather than tautology.
  it('slot DP == atomic engine for draw effects', () => {
    for (const [N, A, C, E] of [[12, 3, 2, 2], [11, 2, 3, 2]] as const) {
      for (const t of [1, 2]) {
        const slot = exactDrawCurve(atLeast(t, A), { A }, N, C, E, 7);
        const atomic = exactSelectionCurveSingleGroup(N, A, t, drawEffect('C', E), C, 7);
        for (let n = 0; n <= 7; n++) expect(atomic[n]!).toBeCloseTo(slot[n]!, 12);
      }
    }
  });

  it('card-by-card scry DP == atomic engine for scry effects', () => {
    for (const [N, A, C, E] of [[12, 3, 2, 2], [10, 4, 2, 3]] as const) {
      for (const t of [1, 2]) {
        const cardwise = exactScryCurveSingleGroup(N, A, t, C, E, 7);
        const atomic = exactSelectionCurveSingleGroup(N, A, t, scryEffect('C', E), C, 7);
        for (let n = 0; n <= 7; n++) expect(atomic[n]!).toBeCloseTo(cardwise[n]!, 12);
      }
    }
  });
});

describe('effect shapes are ordered by how much they actually help', () => {
  // Not decoration: this ordering is derivable from the mechanics, so a
  // violation means a shape's window resolution is wrong even if every
  // individual number looks plausible. It is what caught the brute force's
  // ponder ordering bug (pondering came out WORSE than not pondering).
  it('plain <= ponder(no shuffle) <= ponder <= scry <= draw', () => {
    for (const [N, A, C, E] of [[12, 3, 2, 2], [11, 2, 3, 2], [10, 4, 2, 3]] as const) {
      for (const t of [1, 2]) {
        const noShuffle = { ...ponderEffect('C', E), canShuffle: false };
        const plain = evaluate(N, { A }, atLeast(t, A)).curve;
        const pNo = exactSelectionCurveSingleGroup(N, A, t, noShuffle, C, 7);
        const pYes = exactSelectionCurveSingleGroup(N, A, t, ponderEffect('C', E), C, 7);
        const scry = exactSelectionCurveSingleGroup(N, A, t, scryEffect('C', E), C, 7);
        const draw = exactSelectionCurveSingleGroup(N, A, t, drawEffect('C', E), C, 7);
        for (let n = 1; n <= 7; n++) {
          expect(pNo[n]!).toBeGreaterThanOrEqual(plain[n]! - 1e-12);
          expect(pYes[n]!).toBeGreaterThanOrEqual(pNo[n]! - 1e-12);
          expect(scry[n]!).toBeGreaterThanOrEqual(pYes[n]! - 1e-12);
          expect(draw[n]!).toBeGreaterThanOrEqual(scry[n]! - 1e-12);
        }
      }
    }
  });

  it('the shuffle option is worth something, not nothing', () => {
    // If canShuffle were wired up but inert, the bracket test above would still
    // pass (>= is satisfied by equality), so pin the strict gain separately.
    const withOpt = exactSelectionCurveSingleGroup(12, 3, 1, ponderEffect('C', 2), 2, 7);
    const without = exactSelectionCurveSingleGroup(12, 3, 1, { ...ponderEffect('C', 2), canShuffle: false }, 2, 7);
    expect(withOpt[3]!).toBeGreaterThan(without[3]! + 0.01);
  });
});

describe('the no-cascading scope, measured rather than asserted', () => {
  it('costs real value for put-back effects and is inert for the others', () => {
    const N = 12, A = 3, C = 6, E = 3, t = 1, n = 5;
    const counts = { A, C, '': N - A - C };
    const be = (e: ReturnType<typeof drawEffect>) => ({
      group: 'C', examined: e.examined, keepMax: e.keepMax,
      keptCostsDraw: e.keptCostsDraw, nonKeptLeavesPool: e.nonKeptLeavesPool,
    });
    // Ponder puts unwanted copies BACK on top, so they get drawn and cast for
    // real -- measured at over 8 points here, which is why the scope statement
    // says real values are higher rather than pretending the gap is tiny.
    const ponderNo = bruteSelectionP(counts, n, be({ ...ponderEffect('C', E), canShuffle: false }), { A: t }, false);
    const ponderYes = bruteSelectionP(counts, n, be({ ...ponderEffect('C', E), canShuffle: false }), { A: t }, true);
    expect(ponderYes - ponderNo).toBeGreaterThan(0.08);
    // For the others a window copy is bottomed, exiled, or already in hand, so
    // this particular cascade path cannot occur at all. The OTHER cascade path
    // (casting a copy drawn into hand) is not modeled by the brute force
    // either, so it stays a stated caveat, not a measured zero.
    for (const eff of [drawEffect('C', E), scryEffect('C', E), impulseEffect('C', E)]) {
      const off = bruteSelectionP(counts, n, be(eff), { A: t }, false);
      const on = bruteSelectionP(counts, n, be(eff), { A: t }, true);
      expect(on - off).toBe(0);
    }
  });
});

describe('multi-group AND of thresholds', () => {
  const shapes = (E: number) => [
    ['draw', drawEffect('C', E), 'exact'],
    ['ponder (no shuffle)', { ...ponderEffect('C', E), canShuffle: false }, 'exact'],
    ['scry', scryEffect('C', E), 'sandwich'],
    ['impulse', impulseEffect('C', E), 'sandwich'],
  ] as const;
  const configs: Array<[number, number, number, number, number]> = [
    [12, 3, 2, 2, 2],
    [11, 2, 2, 3, 2],
    [12, 4, 3, 2, 3],
  ];

  for (const [N, A, B, C, E] of configs) {
    for (const [na, nb] of [[1, 1], [2, 1]] as const) {
      for (const [name, eff, kind] of shapes(E)) {
        it(`${name}: N=${N} A=${A}/${na} B=${B}/${nb} copies=${C} examined=${E}`, () => {
          const dp = exactSelectionCurveAnd(N, [{ count: A, need: na }, { count: B, need: nb }], eff, C, 7);
          const counts = { A, B, C, '': N - A - B - C };
          const be = {
            group: 'C', examined: eff.examined, keepMax: eff.keepMax,
            keptCostsDraw: eff.keptCostsDraw, nonKeptLeavesPool: eff.nonKeptLeavesPool,
          };
          for (const n of [2, 3, 5, 7]) {
            const greedy = bruteSelectionP(counts, n, be, { A: na, B: nb });
            if (kind === 'exact') {
              // No keep CHOICE exists for these shapes (you take the whole
              // window, or the whole window gets drawn), so any fixed policy is
              // optimal and the match must be exact.
              expect(dp[n]!).toBeCloseTo(greedy, 12);
            } else {
              // Here the choice is a real optimization, so an exact match
              // against a fixed greedy policy would mean the model ISN'T
              // optimizing. Sandwich it between that policy and a clairvoyant
              // upper bound instead.
              expect(dp[n]!).toBeGreaterThanOrEqual(greedy - 1e-12);
              // The clairvoyant bound branches over every keep subset at every
              // window, for every deck ordering, so it is only affordable at
              // the smaller window size -- checked where it fits rather than
              // dropped or left to time out.
              if (E <= 2 && n <= 5) {
                const upper = bruteSelectionUpperP(counts, n, be, { A: na, B: nb });
                expect(dp[n]!).toBeLessThanOrEqual(upper + 1e-12);
              }
            }
          }
        }, 20000);
      }
    }
  }

  it('reproduces the single-group engine at G=1', () => {
    for (const [N, A, C, E] of [[12, 3, 2, 2], [11, 2, 3, 2]] as const) {
      for (const t of [1, 2]) {
        const one = exactSelectionCurveSingleGroup(N, A, t, scryEffect('C', E), C, 7);
        const many = exactSelectionCurveAnd(N, [{ count: A, need: t }], scryEffect('C', E), C, 7);
        for (let n = 0; n <= 7; n++) expect(many[n]!).toBeCloseTo(one[n]!, 12);
      }
    }
  });

  it('packs state keys wide enough for the folded filler pool', () => {
    // Regression: satisfied groups get folded into the filler pool (exact, and
    // the main speedup), which pushes that count ABOVE the deck's original
    // filler total. The packed state key originally sized that field for the
    // UNFOLDED maximum, so distinct states collided in the memo and returned
    // each other's values -- wrong by 1.5 points in this exact configuration.
    const dp = exactSelectionCurveAnd(12, [{ count: 3, need: 1 }, { count: 2, need: 1 }], drawEffect('C', 2), 2, 7);
    const greedy = bruteSelectionP({ A: 3, B: 2, C: 2, '': 5 }, 7,
      { group: 'C', examined: 2, keepMax: 2, keptCostsDraw: false, nonKeptLeavesPool: true },
      { A: 1, B: 1 });
    expect(dp[7]!).toBeCloseTo(greedy, 12);
  });

  it('rejects group counts that exceed the deck', () => {
    expect(() => exactSelectionCurveAnd(10, [{ count: 6, need: 1 }, { count: 5, need: 1 }], drawEffect('C', 2), 2, 5))
      .toThrow(UnsupportedSelectionError);
  });
});

describe('upper bounds: bricks you do not want to draw', () => {
  // A group with hi=0 is a brick/garnet: drawing one breaks the query. This is
  // the regime where looking and drawing stop being interchangeable, so it gets
  // its own verification rather than riding on the monotone cases.
  const N = 12, A = 3, K = 2, C = 2, E = 2;
  const counts = { A, K, C, '': N - A - K - C };
  const groups = [{ count: A, need: 1 }, { count: K, need: 0, hi: 0 }];
  const need = { A: 1, K: 0 };
  const caps = { K: 0 };
  const be = (e: ReturnType<typeof drawEffect>) => ({
    group: 'C', examined: e.examined, keepMax: e.keepMax,
    keptCostsDraw: e.keptCostsDraw, nonKeptLeavesPool: e.nonKeptLeavesPool,
  });

  it('draw is exact: its window is forced into hand, so there is no choice at all', () => {
    const dp = exactSelectionCurveAnd(N, groups, drawEffect('C', E), C, 7);
    for (const n of [2, 3, 5]) {
      const greedy = bruteSelectionP(counts, n, be(drawEffect('C', E)), need, false, caps);
      expect(dp[n]!).toBeCloseTo(greedy, 12);
    }
  });

  it('every shape that can refuse or reorder is sandwiched', () => {
    // Note ponder CHANGES exactness class here. With no upper bound its window
    // order is irrelevant (every card is welcome), so a fixed policy is optimal.
    // With a brick, ordering it below the draw horizon is a real decision, so
    // greedy stops being exact -- the exactness class depends on the QUERY
    // regime, not only on the effect's mechanics.
    for (const eff of [
      scryEffect('C', E),
      impulseEffect('C', E),
      { ...ponderEffect('C', E), canShuffle: false },
    ]) {
      const dp = exactSelectionCurveAnd(N, groups, eff, C, 7);
      for (const n of [2, 3, 5]) {
        const greedy = bruteSelectionP(counts, n, be(eff), need, false, caps);
        const clair = bruteSelectionUpperP(counts, n, be(eff), need, caps);
        expect(dp[n]!).toBeGreaterThanOrEqual(greedy - 1e-12);
        expect(dp[n]!).toBeLessThanOrEqual(clair + 1e-12);
      }
    }
  }, 30000);

  it('reverses the monotone ordering: looking beats drawing, and drawing is worse than nothing', () => {
    // The headline consequence. With no upper bound, draw >= scry (cards are
    // free rather than costing draws). With a brick, drawing FORCES cards into
    // hand and cannot refuse, so scry overtakes it -- and plain draws fall below
    // running no effect at all.
    const base = evaluate(N, { A, K }, {
      clauses: [{ A: { lo: 1, hi: A }, K: { lo: 0, hi: 0 } }], monotone: false,
    }).curve;
    const draw = exactSelectionCurveAnd(N, groups, drawEffect('C', E), C, 7);
    const scry = exactSelectionCurveAnd(N, groups, scryEffect('C', E), C, 7);
    for (const n of [3, 5]) {
      expect(scry[n]!).toBeGreaterThan(draw[n]!);
      expect(draw[n]!).toBeLessThan(base[n]!);
      expect(scry[n]!).toBeGreaterThan(base[n]!);
    }
    // and the gap is large, not a rounding artifact
    expect(scry[5]! - draw[5]!).toBeGreaterThan(0.15);
  });

  it('produces a curve that DECREASES in draws', () => {
    // Forced draws mean more cards can be strictly worse. Anything downstream
    // that assumes a nondecreasing curve (thresholds like "draws needed to hit
    // 80%") is invalid for a bounded query, hence this pinned explicitly.
    const draw = exactSelectionCurveAnd(N, groups, drawEffect('C', E), C, 7);
    let decreases = false;
    for (let n = 1; n <= 7; n++) if (draw[n]! < draw[n - 1]! - 1e-12) decreases = true;
    expect(decreases).toBe(true);
  });

  it('hi at or above the group count is the same as no bound', () => {
    const withHi = exactSelectionCurveAnd(N, [{ count: A, need: 2, hi: A }], scryEffect('C', E), C, 7);
    const without = exactSelectionCurveAnd(N, [{ count: A, need: 2 }], scryEffect('C', E), C, 7);
    for (let n = 0; n <= 7; n++) expect(withHi[n]!).toBe(without[n]!);
  });
});

describe('OR of clauses', () => {
  // query: (A>=1 AND B>=1) OR (D>=2)
  const N = 12, A = 2, B = 2, D = 3, C = 2, E = 2;
  const counts = { A, B, D, C, '': N - A - B - D - C };
  const groupCounts = [A, B, D];
  const clauses = [
    [{ lo: 1 }, { lo: 1 }, undefined],
    [undefined, undefined, { lo: 2 }],
  ];
  const bclauses = [{ need: { A: 1, B: 1 } }, { need: { D: 2 } }];
  const be = (e: ReturnType<typeof drawEffect>) => ({
    group: 'C', examined: e.examined, keepMax: e.keepMax,
    keptCostsDraw: e.keptCostsDraw, nonKeptLeavesPool: e.nonKeptLeavesPool,
  });

  it('draw is exact (no choice to make)', () => {
    const dp = exactSelectionCurveDnf(N, groupCounts, clauses, drawEffect('C', E), C, 6);
    for (const n of [2, 3, 4]) {
      expect(dp[n]!).toBeCloseTo(bruteSelectionDnfP(counts, n, be(drawEffect('C', E)), bclauses), 12);
    }
  }, 30000);

  it('choice shapes stay inside the greedy/clairvoyant sandwich', () => {
    // The greedy gap is visibly nonzero here (0.330 vs 0.358 at n=3), which is
    // the point: with an OR, committing a card toward one clause spends draws
    // another clause wanted, so the max is doing real work.
    for (const eff of [scryEffect('C', E), impulseEffect('C', E), { ...ponderEffect('C', E), canShuffle: false }]) {
      const dp = exactSelectionCurveDnf(N, groupCounts, clauses, eff, C, 6);
      // n kept small: the clairvoyant search branches over every keep subset at
      // every window for every ordering, so it is the expensive side by far.
      for (const n of [2, 3]) {
        const greedy = bruteSelectionDnfP(counts, n, be(eff), bclauses);
        // Separate function rather than a boolean flag on the same one: the
        // greedy and clairvoyant policies are different instruments (lower vs
        // upper bound), and a trailing `true` had already been misread once as
        // the unrelated `cascade` flag, silently comparing the DP against a
        // LOWER bound in a place that wanted the upper one.
        const clair = bruteSelectionDnfUpperP(counts, n, be(eff), bclauses);
        expect(dp[n]!).toBeGreaterThanOrEqual(greedy - 1e-12);
        expect(dp[n]!).toBeLessThanOrEqual(clair + 1e-12);
      }
    }
  }, 120000);

  it('single-clause DNF reproduces the AND engine', () => {
    const viaDnf = exactSelectionCurveDnf(12, [3], [[{ lo: 2 }]], scryEffect('C', 2), 2, 7);
    const viaAnd = exactSelectionCurveAnd(12, [{ count: 3, need: 2 }], scryEffect('C', 2), 2, 7);
    for (let n = 0; n <= 7; n++) expect(viaDnf[n]!).toBe(viaAnd[n]!);
  });
});

describe('the slot DP is the fast path for draw-shaped effects', () => {
  // A draw effect forces its whole window into hand, so nothing about the
  // resulting hand distribution depends on the query -- which means the slot DP
  // (no group dimensions, cached, query-independent) handles ANY query shape
  // that evaluate() handles, including OR and upper bounds. That matters
  // practically: the heavy engine needs ~25s for a 60-card OR query where this
  // takes ~63ms, so draw-shaped effects must never be routed to the heavy path.
  it('agrees with the heavy engine on an OR query', () => {
    const N = 12, A = 2, B = 2, D = 3, C = 2, E = 2;
    const dnf: Dnf = {
      clauses: [{ A: { lo: 1, hi: A }, B: { lo: 1, hi: B } }, { D: { lo: 2, hi: D } }],
      monotone: true,
    };
    const slot = exactDrawCurve(dnf, { A, B, D }, N, C, E, 6);
    const heavy = exactSelectionCurveDnf(N, [A, B, D],
      [[{ lo: 1 }, { lo: 1 }, undefined], [undefined, undefined, { lo: 2 }]],
      drawEffect('C', E), C, 6);
    for (let n = 0; n <= 6; n++) expect(slot[n]!).toBeCloseTo(heavy[n]!, 12);
  });

  it('agrees with the heavy engine on a brick query', () => {
    const N = 12, A = 3, K = 2, C = 2, E = 2;
    const dnf: Dnf = { clauses: [{ A: { lo: 1, hi: A }, K: { lo: 0, hi: 0 } }], monotone: false };
    const slot = exactDrawCurve(dnf, { A, K }, N, C, E, 7);
    const heavy = exactSelectionCurveDnf(N, [A, K], [[{ lo: 1 }, { lo: 0, hi: 0 }]], drawEffect('C', E), C, 7);
    for (let n = 0; n <= 7; n++) expect(slot[n]!).toBeCloseTo(heavy[n]!, 12);
  });
});

describe('optionalResolve: casting is a choice', () => {
  // Raised from real play: a deck that MUST run a brick (Brilliant Fusion at 3
  // copies needing its Garnet) still wants to cast the copy, while a generic
  // draw spell would simply be declined. The model forced resolution, which is
  // what made drawing look strictly worse than doing nothing.
  const N = 12, A = 3, K = 2, C = 2, E = 2;
  const brick = [[{ lo: 1 }, { lo: 0, hi: 0 }]];
  const baseline = evaluate(N, { A, K }, {
    clauses: [{ A: { lo: 1, hi: A }, K: { lo: 0, hi: 0 } }], monotone: false,
  }).curve;

  it('never hurts, and lifts drawing back above doing nothing', () => {
    const must = exactSelectionCurveDnf(N, [A, K], brick, drawEffect('C', E), C, 7);
    const opt = exactSelectionCurveDnf(N, [A, K], brick, { ...drawEffect('C', E), optionalResolve: true }, C, 7);
    for (let n = 0; n <= 7; n++) expect(opt[n]!).toBeGreaterThanOrEqual(must[n]! - 1e-12);
    // The headline correction: forced resolution put draw BELOW the no-effect
    // baseline (0.163 vs 0.292 at n=5); declining restores it above.
    expect(must[5]!).toBeLessThan(baseline[5]!);
    expect(opt[5]!).toBeGreaterThanOrEqual(baseline[5]! - 1e-12);
  });

  it('changes nothing for scry, which could already refuse', () => {
    const must = exactSelectionCurveDnf(N, [A, K], brick, scryEffect('C', E), C, 7);
    const opt = exactSelectionCurveDnf(N, [A, K], brick, { ...scryEffect('C', E), optionalResolve: true }, C, 7);
    for (let n = 0; n <= 7; n++) expect(opt[n]!).toBe(must[n]!);
  });

  it('is exactly inert for monotone queries', () => {
    // Resolving is never a mistake when every card is welcome, so the option has
    // to be worth precisely zero -- a difference here would mean the max is
    // picking up something it shouldn't.
    for (const eff of [drawEffect('C', E), scryEffect('C', E), impulseEffect('C', E)]) {
      const must = exactSelectionCurveDnf(N, [A], [[{ lo: 2 }]], eff, C, 7);
      const opt = exactSelectionCurveDnf(N, [A], [[{ lo: 2 }]], { ...eff, optionalResolve: true }, C, 7);
      for (let n = 0; n <= 7; n++) expect(opt[n]!).toBe(must[n]!);
    }
  });
});
