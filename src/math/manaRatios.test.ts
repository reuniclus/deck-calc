import { describe, expect, it } from 'vitest';
import {
  basicsFromRatios, castabilityOverSeen, phiApprox, phiExact, ratioVerdict, sourcesOverSeen,
} from './manaRatios';
import { sfAtLeast } from './hyper';
import { slotDistribution } from './selection';
import { basicsBudget } from './basicsBudget';
import { cardsSeen, EDH, LIMITED, SIXTY } from './manaSources';

describe('the manabase in dimensionless form', () => {
  it('the required FRACTION is deck-size-free at fixed cards seen', () => {
    // Within about a point across 40 / 60 / 99 cards, which is what licenses working in
    // ratios at all. Deck size drops out; cards seen does not.
    const at10 = [EDH, SIXTY, LIMITED].map((cfg) => phiExact(cfg.deckSize, 10, 1, 0.9));
    for (const f of at10) expect(f).toBeCloseTo(at10[0]!, 2);
  });

  it('the binomial closed form is close, and biased HIGH', () => {
    for (const n of [8, 10, 12, 15]) {
      const approx = phiApprox(n, 0.9);
      const exact = phiExact(99, n, 1, 0.9);
      expect(approx).toBeGreaterThanOrEqual(exact - 1e-9);
      expect(approx - exact).toBeLessThan(0.012);
    }
  });

  it('feasibility is exactly rho <= k', () => {
    const phi = phiExact(99, cardsSeen(EDH, 4), 1, 0.9); // ~0.182
    // five colours off duals: rho = 5*phi / (38/99) = 2.37 > 2
    const five = ratioVerdict({ demandFraction: 5 * phi, landFraction: 38 / 99, coloursPerNonBasic: 2 });
    expect(five.feasible).toBe(false);
    expect(five.rho).toBeGreaterThan(2);
    // the same demand off rainbows is fine
    const rainbow = ratioVerdict({ demandFraction: 5 * phi, landFraction: 38 / 99, coloursPerNonBasic: 5 });
    expect(rainbow.feasible).toBe(true);
  });

  it('tells you the land fraction that would rescue an infeasible deck', () => {
    const phi = phiExact(99, cardsSeen(EDH, 4), 1, 0.9);
    const v = ratioVerdict({ demandFraction: 5 * phi, landFraction: 38 / 99, coloursPerNonBasic: 2 });
    expect(v.feasible).toBe(false);
    // rho <= k  <=>  lambda >= Phi/k
    const rescued = ratioVerdict({
      demandFraction: 5 * phi, landFraction: v.landFractionNeeded, coloursPerNonBasic: 2,
    });
    expect(rescued.feasible).toBe(true);
    expect(v.landFractionNeeded * 99).toBeGreaterThan(38); // needs more lands than it has
  });

  it('agrees with the count-based budget', () => {
    // The two formulations must not drift apart. Same answer, different units.
    for (const colours of [2, 3, 4]) {
      for (const k of [2, 3]) {
        if (k > colours) continue;
        const counts = new Array(colours).fill(18) as number[];
        const fromCounts = basicsBudget(38, counts, k).maxBasics;
        const fromRatios = basicsFromRatios(38, 99, colours * (18 / 99), k);
        expect(Math.abs(fromCounts - fromRatios)).toBeLessThanOrEqual(1); // integer rounding
      }
    }
  });

  it('card draw loosens the manabase without changing any ratio', () => {
    // The point where this meets the cantrip work: more cards seen lowers phi, which
    // lowers rho, which raises the basics fraction -- with land count untouched.
    const tight = ratioVerdict({
      demandFraction: 3 * phiExact(99, 11, 1, 0.9), landFraction: 38 / 99, coloursPerNonBasic: 2,
    });
    const drawy = ratioVerdict({
      demandFraction: 3 * phiExact(99, 16, 1, 0.9), landFraction: 38 / 99, coloursPerNonBasic: 2,
    });
    expect(drawy.rho).toBeLessThan(tight.rho);
    expect(drawy.basicsFraction).toBeGreaterThan(tight.basicsFraction);
  });
});


describe('cards seen as a distribution', () => {
  // 99 cards, 11 scheduled draws, 8 look-3 cantrips. slotDistribution already yields the
  // distribution of cards seen, so the draw half of the project feeds the manabase half.
  const dist = slotDistribution(99, 8, 3, 11)[11]!.map((o) => ({ seen: o.seen, p: o.p }));

  it('mixing over the spread differs materially from using the mean', () => {
    const mean = dist.reduce((a, d) => a + d.p * d.seen, 0);
    const atMean = sfAtLeast(99, 18, Math.round(mean), 1);
    const mixed = castabilityOverSeen(99, 18, 1, dist);
    // concave in n, so the mean OVERSTATES -- by 1.2pt here, twelve times the bar
    expect(mixed).toBeLessThan(atMean);
    expect((atMean - mixed) * 100).toBeGreaterThan(1);
    expect(dist.reduce((a, d) => a + d.p, 0)).toBeCloseTo(1, 9);
  });

  it('a wider spread costs more than a narrow one at equal mean', () => {
    const mean = dist.reduce((a, d) => a + d.p * d.seen, 0);
    const point = [{ seen: Math.round(mean), p: 1 }];
    expect(castabilityOverSeen(99, 18, 1, dist))
      .toBeLessThan(castabilityOverSeen(99, 18, 1, point));
  });

  it('requires more sources once the spread is respected', () => {
    const mean = Math.round(dist.reduce((a, d) => a + d.p * d.seen, 0));
    const naive = sourcesOverSeen(99, 1, 0.9, [{ seen: mean, p: 1 }]);
    const honest = sourcesOverSeen(99, 1, 0.9, dist);
    expect(honest).toBeGreaterThanOrEqual(naive);
  });
});
