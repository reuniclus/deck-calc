/**
 * The manabase problem in dimensionless form.
 *
 * Everything except ONE quantity can be expressed as a ratio, which removes deck size
 * from the discussion and makes the whole thing a small closed-form system:
 *
 *     phi*(n, conf, pips)   required sources as a FRACTION of the deck
 *     Phi = sum_c phi*_c    total colour demand
 *     lambda = lands / deck land fraction
 *     rho = Phi / lambda    colour-slots demanded per land
 *     beta <= (k - rho)/(k - 1)   basics as a fraction of lands
 *     feasible  <=>  rho <= k
 *
 * The last line is the whole manabase question in five symbols: the colour demand per
 * land cannot exceed how many colours your lands produce.
 *
 * ## The one thing that is NOT a ratio
 *
 * `n`, cards seen. Measured against the exact hypergeometric, the required FRACTION at
 * fixed `n` is within about a point across deck sizes from 40 to 99 (n=10: 20.2% in EDH,
 * 20.0% at sixty, 20.0% in limited), so deck size drops out and `n` does not.
 *
 * That is not a defect, it is the physics: seeing more cards is exactly what loosens a
 * manabase. It is why a thirty-land draw-heavy deck needs fewer sources than a
 * thirty-eight-land midrange one -- card draw raises `n` without touching any ratio --
 * and it is the point where this meets the cantrip work.
 *
 * ## Accuracy
 *
 * `phiApprox` is the binomial limit, which ignores the finite-population correction and
 * runs ~0.7pt high. Use `phiExact` when it matters; the approximation is for intuition
 * and for showing a user the SHAPE of the tradeoff.
 */
import { sfAtLeast } from './hyper';
import { minSources } from './manaSources';

/** Required source fraction, binomial limit. Exact only as deck size -> infinity. */
export function phiApprox(cardsSeen: number, confidence: number): number {
  if (cardsSeen <= 0) return 1;
  return 1 - Math.pow(1 - confidence, 1 / cardsSeen);
}

/** Required source fraction, exact for this deck size. */
export function phiExact(
  deckSize: number, cardsSeen: number, pips: number, confidence: number,
): number {
  const s = minSources(deckSize, cardsSeen, pips, confidence);
  return Number.isFinite(s) ? s / deckSize : Infinity;
}

export interface RatioInputs {
  /** Total colour demand as a fraction of the deck, `sum phi_c`. */
  demandFraction: number;
  /** Lands as a fraction of the deck. */
  landFraction: number;
  /** Colours produced by each non-basic. */
  coloursPerNonBasic: number;
}

export interface RatioVerdict {
  /** Colour-slots demanded per land. */
  rho: number;
  /** Basics as a fraction of lands, or 0 when infeasible. */
  basicsFraction: number;
  feasible: boolean;
  /** Land fraction that WOULD make it feasible at this demand and breadth. */
  landFractionNeeded: number;
}

export function ratioVerdict(inp: RatioInputs): RatioVerdict {
  const { demandFraction: Phi, landFraction: lambda, coloursPerNonBasic: k } = inp;
  const rho = lambda > 0 ? Phi / lambda : Infinity;
  const feasible = rho <= k;
  const beta = k > 1 ? (k - rho) / (k - 1) : 1 - rho;
  return {
    rho,
    basicsFraction: feasible ? Math.max(0, Math.min(1, beta)) : 0,
    feasible,
    // rho <= k  <=>  lambda >= Phi / k
    landFractionNeeded: Phi / k,
  };
}

/**
 * Sanity bridge: the fraction law must agree with the count-based budget. Kept as a
 * function rather than only a test so callers can assert it on their own inputs.
 */
export function basicsFromRatios(
  landCount: number, deckSize: number, demandFraction: number, coloursPerNonBasic: number,
): number {
  const v = ratioVerdict({
    demandFraction, landFraction: landCount / deckSize, coloursPerNonBasic,
  });
  return Math.floor(v.basicsFraction * landCount);
}

/** Confidence actually achieved at a given source fraction, for one pip. */
export function confidenceAt(
  deckSize: number, cardsSeen: number, sourceFraction: number, pips = 1,
): number {
  return sfAtLeast(deckSize, Math.round(sourceFraction * deckSize), cardsSeen, pips);
}

/** Cards seen is a random variable when the deck draws: `{seen, p}` pairs summing to 1. */
export interface SeenDistribution {
  seen: number;
  p: number;
}

/**
 * Castability mixed over the DISTRIBUTION of cards seen, rather than evaluated at its
 * mean.
 *
 * `n` is the one quantity the ratio form cannot normalise away -- so rather than pinning
 * it to a point, carry it as a distribution. `slotDistribution` already produces exactly
 * this from a cantrip package, which is where the manabase half of the project meets the
 * draw half.
 *
 * This is not presentational. `P(>=k sources | n)` is CONCAVE in `n`, so
 * `E[P(n)] < P(E[n])` and using the mean OVERSTATES castability. Measured on a 99-card
 * deck with eight look-3 cantrips: mean seen 13.67, `P` at the mean 95.202%, mixed
 * 93.983% -- a **1.2pt** gap, twelve times the 0.1pt bar. The spread is wide (seen ranges
 * 11 to 35, a long right tail from chaining), which is precisely when a mean is a poor
 * summary.
 */
export function castabilityOverSeen(
  deckSize: number, sources: number, pips: number, dist: SeenDistribution[],
): number {
  let acc = 0;
  for (const { seen, p } of dist) {
    if (p <= 0) continue;
    acc += p * sfAtLeast(deckSize, sources, Math.min(seen, deckSize), pips);
  }
  return acc;
}

/** Sources needed once the spread in cards seen is accounted for. */
export function sourcesOverSeen(
  deckSize: number, pips: number, confidence: number, dist: SeenDistribution[],
): number {
  for (let k = pips; k <= deckSize; k++) {
    if (castabilityOverSeen(deckSize, k, pips, dist) >= confidence) return k;
  }
  return Infinity;
}
