/**
 * Propose a manabase, price basics, and give the general heuristic.
 *
 * `landTypes.ts` VERIFIES a composition; this proposes one, and then verifies its own
 * proposal with `checkSupply` rather than trusting the arithmetic that produced it.
 *
 * ## What "propose" means here
 *
 * Maximise basics subject to meeting every colour requirement, which is the actual
 * player question -- all-nonbasic is trivially most consistent and nobody wants to be
 * told that. Basics are spread as evenly as the requirements allow, and the deficit is
 * covered by the broadest non-basic available.
 *
 * The construction is greedy, so it is a FEASIBLE proposal rather than a proven optimum.
 * That is why it is checked afterwards: a greedy answer that passes `checkSupply` is
 * useful, and one that fails is a bug rather than a rounding difference.
 */
import { sfAtLeast } from './hyper';
import { checkSupply, type LandType, type SupplyVerdict } from './landTypes';
import { minSources, type DeckConfig } from './manaSources';
import { cardsSeen } from './manaSources';

export interface Proposal {
  types: LandType[];
  basics: number;
  nonBasics: number;
  /** Verified with `checkSupply`, not asserted by the constructor. */
  verdicts: SupplyVerdict[];
  feasible: boolean;
}

/**
 * Greedy composition: fill with basics, then convert basics into broad non-basics until
 * every requirement is met.
 *
 * Converting rather than adding is the point -- the land count is FIXED, so a non-basic
 * always costs a basic. That is the same displacement the budget identity's `k-1` divisor
 * encodes.
 */
export function proposeManabase(
  landCount: number,
  requirements: Array<{ colour: string; sources: number; pips: number }>,
  coloursPerNonBasic: number,
): Proposal {
  const colours = requirements.map((r) => r.colour);
  const nc = colours.length;
  // Non-basics are modelled as covering the first `coloursPerNonBasic` colours in
  // rotation, which for an even requirement spread is what a real cycle of duals or
  // triomes does.
  const build = (nonBasics: number): LandType[] => {
    const basics = landCount - nonBasics;
    const types: LandType[] = [];
    for (let i = 0; i < nc; i++) {
      const share = Math.floor(basics / nc) + (i < basics % nc ? 1 : 0);
      if (share > 0) types.push({ name: `basic-${colours[i]!}`, count: share, colours: [colours[i]!], isBasic: true });
    }
    for (let i = 0; i < nonBasics; i++) {
      const set = Array.from({ length: Math.min(coloursPerNonBasic, nc) },
        (_, j) => colours[(i + j) % nc]!);
      types.push({ name: `nb-${i}`, count: 1, colours: [...new Set(set)] });
    }
    return types;
  };

  for (let nonBasics = 0; nonBasics <= landCount; nonBasics++) {
    const types = build(nonBasics);
    const verdicts = checkSupply(types, requirements);
    if (verdicts.every((v) => v.meetsSourceCount && v.hasEnoughDistinct)) {
      return {
        types, basics: landCount - nonBasics, nonBasics, verdicts, feasible: true,
      };
    }
  }
  const types = build(landCount);
  return {
    types, basics: 0, nonBasics: landCount,
    verdicts: checkSupply(types, requirements), feasible: false,
  };
}

export interface BasicPrice {
  basics: number;
  /** Worst per-colour supply under this many basics. */
  worstSupply: number;
  /** P(cast on time) for the worst colour. */
  probability: number;
  /** Points below the target confidence. */
  hitPt: number;
}

/**
 * The price of basics: for each count from the maximum feasible upward, what the worst
 * colour's castability becomes.
 *
 * This is the question the budget alone cannot answer -- "you can afford 22" says nothing
 * about what the 23rd costs, and the answer is rarely "everything".
 */
export function priceOfBasics(
  cfg: DeckConfig, landCount: number, colourCount: number, pips: number, turn: number,
  coloursPerNonBasic: number, upTo?: number,
): BasicPrice[] {
  const seen = cardsSeen(cfg, turn);
  const required = minSources(cfg.deckSize, seen, pips, cfg.confidence);
  const target = Number.isFinite(required) ? sfAtLeast(cfg.deckSize, required, seen, pips) : 1;
  const out: BasicPrice[] = [];
  const max = Math.min(landCount, upTo ?? landCount);
  for (let basics = 0; basics <= max; basics++) {
    const nonBasics = landCount - basics;
    // even spread: each colour gets its share of basics, plus every non-basic
    const perColourBasics = Math.floor(basics / colourCount);
    const supply = perColourBasics + Math.min(nonBasics,
      Math.floor((nonBasics * coloursPerNonBasic) / colourCount));
    const p = sfAtLeast(cfg.deckSize, Math.max(0, supply), seen, pips);
    out.push({ basics, worstSupply: supply, probability: p, hitPt: (target - p) * 100 });
  }
  return out;
}

export interface HeuristicRow {
  colours: number;
  coloursPerNonBasic: number;
  required: number;
  maxBasics: number;
  /** Cost of the first basic past the budget, in points of castability. */
  nextBasicPt: number;
}

/**
 * The general heuristic: even requirement spread, no musts, one pip by a given turn.
 *
 * Deliberately assumes symmetry. Real decks are not symmetric, and the asymmetric answer
 * is what `proposeManabase` is for -- but a player wants a number to start from, and
 * "2-colour can be all basics, 4-colour cannot" is the useful shape.
 */
export function heuristicTable(
  cfg: DeckConfig, landCount: number, turn: number, pips = 1,
): HeuristicRow[] {
  const seen = cardsSeen(cfg, turn);
  const required = minSources(cfg.deckSize, seen, pips, cfg.confidence);
  const rows: HeuristicRow[] = [];
  for (const colours of [2, 3, 4, 5]) {
    for (const k of [2, 3, 5]) {
      if (k > colours) continue;
      const priced = priceOfBasics(cfg, landCount, colours, pips, turn, k);
      const feasible = priced.filter((p) => p.hitPt <= 1e-9);
      const maxBasics = feasible.length > 0 ? feasible[feasible.length - 1]!.basics : -1;
      const next = priced.find((p) => p.basics === maxBasics + 1);
      rows.push({
        colours, coloursPerNonBasic: k, required,
        maxBasics,
        nextBasicPt: next ? next.hitPt : Number.NaN,
      });
    }
  }
  return rows;
}
