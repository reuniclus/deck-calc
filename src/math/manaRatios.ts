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

export interface NPoint {
  /** Cards seen. */
  n: number;
  /** Required source fraction at this `n`. */
  phi: number;
  /** Colour-slots demanded per land. */
  rho: number;
  /** Affordable basics as a fraction of lands. */
  basicsFraction: number;
  feasible: boolean;
}

/**
 * The verdict as a CURVE over cards seen.
 *
 * Since `n` is the only quantity that cannot be normalised away, sweeping it keeps the
 * result generic: a manabase is not "feasible" or not, it is feasible ABOVE SOME `n`.
 * That single threshold is more useful than any point estimate, because it converts a
 * verdict into a requirement on the deck's draw.
 */
export function verdictOverN(
  colours: number, landFraction: number, coloursPerNonBasic: number,
  confidence: number, nRange: number[],
): NPoint[] {
  return nRange.map((n) => {
    const phi = phiApprox(n, confidence);
    const v = ratioVerdict({
      demandFraction: colours * phi, landFraction, coloursPerNonBasic,
    });
    return { n, phi, rho: v.rho, basicsFraction: v.basicsFraction, feasible: v.feasible };
  });
}

/** Smallest `n` at which the manabase becomes feasible, or null within the range. */
export function feasibleFrom(points: NPoint[]): number | null {
  const hit = points.find((p) => p.feasible);
  return hit ? hit.n : null;
}

/**
 * Integrate the verdict over a DISTRIBUTION of cards seen.
 *
 * A deck with cantrips does not see a fixed number of cards by turn T -- it sees a
 * distribution, which the draw machinery already computes. So the honest output is not
 * "feasible" but P(feasible), plus the basics fraction one can afford at a chosen
 * reliability.
 *
 * This is where the two halves of the project meet: the cantrip engines produce the
 * distribution over `n`, and the manabase consumes it.
 */
export function verdictOverDistribution(
  colours: number, landFraction: number, coloursPerNonBasic: number,
  confidence: number, nDistribution: Array<{ n: number; p: number }>,
): { pFeasible: number; expectedBasicsFraction: number; safeBasicsFraction: number } {
  let pFeasible = 0;
  let expected = 0;
  const sorted = [...nDistribution].sort((a, b) => a.n - b.n);
  // The basics fraction that still holds up on a BAD draw: the value at the 10th
  // percentile of cards seen, taken at the first bucket whose cumulative mass reaches
  // the tail. An earlier version only assigned inside `cum <= 0.1`, so a first bucket
  // heavier than 10% left it at its initial value and it reported 1.
  let safe: number | null = null;
  let cum = 0;
  for (const { n, p } of sorted) {
    const v = ratioVerdict({
      demandFraction: colours * phiApprox(n, confidence), landFraction, coloursPerNonBasic,
    });
    if (v.feasible) pFeasible += p;
    expected += p * v.basicsFraction;
    cum += p;
    if (safe === null && cum >= 0.1) safe = v.basicsFraction;
  }
  const worstAtReliability = safe ?? (sorted.length > 0
    ? ratioVerdict({
      demandFraction: colours * phiApprox(sorted[0]!.n, confidence),
      landFraction, coloursPerNonBasic,
    }).basicsFraction
    : 0);
  return {
    pFeasible,
    expectedBasicsFraction: expected,
    safeBasicsFraction: worstAtReliability,
  };
}

export interface RhoProfile {
  /** Per-colour demand, `req_c / L`. */
  perColour: Array<{ colour: string; rho: number }>;
  /** Aggregate demand, the SUM of the per-colour values. */
  total: number;
  /** Largest per-colour demand -- the singleton end of Hall's condition. */
  worstColour: number;
  /**
   * 1 when demands are even, higher when skewed. Above ~1.3 the aggregate is a poor
   * summary and the per-colour end is likelier to bind.
   */
  skew: number;
  /** `rho_c <= 1` for every colour: no colour may demand more than every land. */
  perColourOk: boolean;
  /** `rho <= k`: total demand within total breadth. */
  aggregateOk: boolean;
  /** Which end binds, or `null` when both pass. */
  binding: 'per-colour' | 'aggregate' | 'both' | null;
}

/**
 * The two ends of Hall's condition, reported together.
 *
 * `rho` alone is an aggregate and therefore blind to SHAPE: 3 colours needing 18 each and
 * 3 colours needing 30/12/12 share `rho = 1.42` and are not equally buildable. The
 * per-colour vector restores what the sum discards, and the pair of checks is far
 * stronger than either alone:
 *
 *  - `rho_c <= 1` (singleton subsets) -- a colour needing more sources than you have
 *    lands is dead however broad those lands are;
 *  - `rho <= k` (the full subset) -- total demand cannot exceed total breadth.
 *
 * Intermediate subsets are the rest of Hall's condition and are not checked here; this is
 * a SCREEN, not a proof. `checkSupply` in `landTypes.ts` decides an actual composition.
 */
export function rhoProfile(
  requirements: Array<{ colour: string; sources: number }>,
  landCount: number, coloursPerNonBasic: number,
): RhoProfile {
  const perColour = requirements.map((r) => ({
    colour: r.colour, rho: landCount > 0 ? r.sources / landCount : Infinity,
  }));
  const total = perColour.reduce((a, r) => a + r.rho, 0);
  const worstColour = perColour.reduce((a, r) => Math.max(a, r.rho), 0);
  const mean = perColour.length > 0 ? total / perColour.length : 0;
  const k = Math.min(coloursPerNonBasic, Math.max(1, requirements.length));
  const perColourOk = worstColour <= 1 + 1e-9;
  const aggregateOk = total <= k + 1e-9;
  return {
    perColour,
    total,
    worstColour,
    skew: mean > 0 ? worstColour / mean : 1,
    perColourOk,
    aggregateOk,
    binding: perColourOk && aggregateOk ? null
      : !perColourOk && !aggregateOk ? 'both'
        : perColourOk ? 'aggregate' : 'per-colour',
  };
}

export interface ColourShare {
  colour: string;
  /** Fraction of the deck's coloured spells needing this colour. Shares sum to 1. */
  share: number;
  /** Sources of this colour the manabase actually provides. */
  sources: number;
  /** Pips of this colour on a typical card needing it. */
  pips: number;
}

export interface Coverage {
  /** Expected fraction of coloured spells castable on time. */
  coverage: number;
  /** Per-colour contribution, so the worst offender is visible. */
  perColour: Array<{ colour: string; share: number; castability: number; lostPt: number }>;
  /** Colour whose shortfall costs the most, share-weighted. */
  worstOffender: string | null;
}

/**
 * Expected fraction of coloured spells castable on time.
 *
 * This is the metric that distinguishes a 10/20/70 colour split from an even one, which
 * `rho_c` CANNOT: because requirements are a max over cards, a colour on one card and a
 * colour on thirty cards demand the same sources, so the shares vanish. Weighting
 * castability by share restores them -- failing a 70% colour costs seven times what
 * failing a 10% colour costs, and no floor-based figure says so.
 *
 * Use alongside the requirement view, not instead of it: a floor answers "will this card
 * work", coverage answers "how much of my deck works". They disagree usefully, and a
 * splash is exactly where they should.
 */
export function coverage(deckSize: number, cardsSeen: number, shares: ColourShare[]): Coverage {
  const perColour = shares.map((s) => {
    const castability = sfAtLeast(deckSize, s.sources, cardsSeen, s.pips);
    return {
      colour: s.colour,
      share: s.share,
      castability,
      lostPt: s.share * (1 - castability) * 100,
    };
  });
  const total = perColour.reduce((a, r) => a + r.share * r.castability, 0);
  const worst = perColour.reduce<{ colour: string; lostPt: number } | null>(
    (a, r) => (a === null || r.lostPt > a.lostPt ? { colour: r.colour, lostPt: r.lostPt } : a),
    null,
  );
  return { coverage: total, perColour, worstOffender: worst ? worst.colour : null };
}

export interface HeuristicCell {
  colours: number;
  landCount: number;
  lambda: number;
  rho: number;
  /** Basics as a fraction of lands with duals, or null when infeasible. */
  withDuals: number | null;
  /** Same with triomes. */
  withTriomes: number | null;
}

/**
 * The even-distribution heuristic table: what fraction of lands can be basics, by colour
 * count and land count.
 *
 * Generated rather than hard-coded so it cannot drift from the functions it summarises,
 * and so a caller can regenerate it for a different format, confidence, pip count or turn.
 *
 * Assumes an even colour spread and no musts, which is what makes it a HEURISTIC: real
 * decks are skewed, and `coverage` plus `rhoProfile` are what handle that. This is the
 * number to start from, not the number to build on.
 */
export function evenDistributionTable(
  deckSize: number, cardsSeen: number, confidence: number,
  landCounts: number[], colourCounts: number[], pips = 1,
): HeuristicCell[] {
  const phi = phiExact(deckSize, cardsSeen, pips, confidence);
  const out: HeuristicCell[] = [];
  for (const landCount of landCounts) {
    const lambda = landCount / deckSize;
    for (const colours of colourCounts) {
      const rho = (colours * phi) / lambda;
      const beta = (kRaw: number): number | null => {
        const k = Math.min(kRaw, colours);
        if (k < 2) return rho <= 1 ? 1 : null;
        return rho > k ? null : Math.min(1, (k - rho) / (k - 1));
      };
      out.push({ colours, landCount, lambda, rho, withDuals: beta(2), withTriomes: beta(3) });
    }
  }
  return out;
}
