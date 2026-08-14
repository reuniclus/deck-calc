/**
 * "How many basics can I afford, and what does each one cost me?"
 *
 * The trade: a dual or rainbow serves several colour requirements at once, so
 * all-nonbasic is the most consistent manabase -- and the most expensive, slowest and
 * most vulnerable to hate. Players want to know the CONSISTENCY PRICE of basics, not
 * to be told to run none.
 *
 * ## The budget identity
 *
 * With `L` lands, per-colour requirements `req_c`, `R = sum req_c`, and non-basics that
 * each produce `k` colours: a basic contributes 1 colour-slot, a non-basic `k`. Covering
 * `R` slots needs `B + k(L - B) >= R`, so
 *
 *     B + k(L - B) >= R   =>   B <= (k*L - R) / (k - 1)
 *
 * The divisor matters and was omitted in the first version of this file: each basic
 * DISPLACES a k-colour land, so it costs `k-1` slots, not 1. At `k=2` the divisor is 1
 * and the two forms coincide -- which is why six duals-based checks all passed and the
 * error survived. It showed up only when triomes (`k=3`) were considered: the wrong form
 * claimed 3-colour triomes allowed 60 basics (i.e. "all of them"), when the true figure
 * is 30. Verified by construction: 30 basics + 8 triomes = 30 + 24 = 54 = R exactly,
 * while 31 + 7*3 = 52 < 54 fails.
 *
 * It reproduces how decks are actually built, which is the reason to trust it: 2-colour
 * with duals allows more basics than there are lands (so all basics are fine); 4-colour
 * with duals allows 4; 5-colour with duals is INFEASIBLE, which is exactly why
 * five-colour decks run rainbows and fetches rather than duals.
 *
 * Sensitivity worth surfacing rather than burying: `dB/dL = k/(k-1)`, so at `k=2` every
 * land added buys TWO basics. 4-colour duals allows 4 basics at 38 lands, 8 at 39, none
 * at 37 -- a one-land change swings the answer by half. Land count is an input, never a
 * constant.
 *
 * ## What it is NOT
 *
 * Necessary, not sufficient. It counts colour-SLOTS and ignores which colours those
 * slots are for: three W/U duals do nothing for a green requirement. The full test is
 * Hall's condition over colour subsets (see the revision notes in
 * `docs/manabase-spec.md`), and this identity is its aggregate relaxation -- an upper
 * bound on basics, assuming non-basic types can be chosen freely.
 *
 * So use it as a BUDGET and a price tag, not a feasibility proof.
 */
import { sfAtLeast } from './hyper';
import { cardsSeen, minSources, type DeckConfig } from './manaSources';

export interface BasicsBudget {
  /** Total colour-slots demanded, `sum req_c`. */
  demand: number;
  /** Colour-slots supplied if every land were a non-basic, `k*L`. */
  supply: number;
  /** Most basics that can fit, capped at the land count. Negative supply means the
   * requirements cannot be met with these land types at all. */
  maxBasics: number;
  /** True when the requirements are unreachable regardless of how few basics you run. */
  infeasible: boolean;
  /** True when basics cost nothing -- every land could be a basic. */
  basicsFree: boolean;
}

export function basicsBudget(
  landCount: number, requirements: number[], coloursPerNonBasic: number,
): BasicsBudget {
  const demand = requirements.reduce((a, r) => a + r, 0);
  const supply = coloursPerNonBasic * landCount;
  if (coloursPerNonBasic < 2) {
    // every land single-colour: basics are all you have, and coverage is just L >= R
    return {
      demand, supply: landCount, maxBasics: landCount,
      infeasible: landCount < demand, basicsFree: landCount >= demand,
    };
  }
  const raw = (supply - demand) / (coloursPerNonBasic - 1);
  return {
    demand,
    supply,
    maxBasics: supply < demand ? 0 : Math.max(0, Math.min(landCount, Math.floor(raw))),
    infeasible: supply < demand,
    basicsFree: raw >= landCount,
  };
}

export interface ConsistencyCost {
  /** Sources for this colour after the basic is added instead of a dual. */
  sources: number;
  /** P(cast on time) at that source count. */
  probability: number;
  /** Points of probability lost versus meeting the requirement exactly. */
  costPt: number;
}

/**
 * The price of going over budget: each basic past `maxBasics` forfeits `k-1`
 * colour-slots, pushing some colour below its requirement. This reports what that
 * costs in castability, so the user sees "3 more basics costs 4.1pt on green" rather
 * than an unexplained "infeasible".
 *
 * Deliberately reports the FULL curve down rather than a single verdict: the shape
 * matters, because the first source below requirement is cheap and the fifth is not.
 */
export function consistencyCost(
  cfg: DeckConfig, pips: number, turn: number, sourcesFrom: number, sourcesTo: number,
): ConsistencyCost[] {
  const seen = cardsSeen(cfg, turn);
  const required = minSources(cfg.deckSize, seen, pips, cfg.confidence);
  const base = Number.isFinite(required) ? sfAtLeast(cfg.deckSize, required, seen, pips) : 1;
  const out: ConsistencyCost[] = [];
  for (let s = sourcesFrom; s >= sourcesTo; s--) {
    const p = sfAtLeast(cfg.deckSize, s, seen, pips);
    out.push({ sources: s, probability: p, costPt: (base - p) * 100 });
  }
  return out;
}

/** One colour requirement a deck actually has. */
export interface ColourNeed {
  colour: string;
  /** Pips of this colour in the cost. */
  pips: number;
  /** Turn it must be castable by. */
  turn: number;
  /**
   * MUST: the deck does not function without it, so it sets the floor.
   * Otherwise it is a WANT -- a splash or a nice-to-have, priced but not enforced.
   * This is the fix for the splash problem: a single off-colour card previously
   * demanded full support because every card was implicitly a must.
   */
  must: boolean;
}

export interface DeckShape {
  deckSize: number;
  /** Lands in the deck. Never assume a number -- a 30-land draw-heavy deck and a
   * 38-land midrange deck give completely different budgets. */
  landCount: number;
  openingHand: number;
  drawsOnFirstTurn: boolean;
  confidence: number;
  /**
   * Extra cards seen per turn beyond the natural draw, from cantrips and draw engines.
   * This is where the draw work meets the manabase: seeing more cards means needing
   * fewer sources, so a draw-heavy deck genuinely can run a worse mana base.
   */
  extraDrawPerTurn?: number;
}

export interface ColourRequirement {
  colour: string;
  /** Sources needed by the MUSTs alone -- the real floor. */
  mustSources: number;
  /** Sources needed to also serve every want. */
  allSources: number;
  /** Cost in sources of promoting the wants to musts. */
  wantPremium: number;
  /** True when the floor exceeds the land count, so mana rocks or dorks are required --
   * a land-only manabase cannot get there however it is built. */
  needsNonLandSources: boolean;
}

/** Cards seen by turn T for a deck shape, including extra draw. */
export function seenBy(shape: DeckShape, turn: number): number {
  const natural = shape.drawsOnFirstTurn ? turn : turn - 1;
  const extra = (shape.extraDrawPerTurn ?? 0) * Math.max(0, turn - 1);
  return Math.min(shape.deckSize, shape.openingHand + Math.max(0, natural) + Math.round(extra));
}

/**
 * Per-colour requirements, separating musts from wants.
 *
 * Uses max-over-cards WITHIN each category, which is right for a must (every must has to
 * work) and informative for a want (what full support would cost). What it deliberately
 * does not do is mix them into one number, which is what made a 1-of splash dictate the
 * whole manabase.
 */
export function colourRequirements(shape: DeckShape, needs: ColourNeed[]): ColourRequirement[] {
  const colours = [...new Set(needs.map((n) => n.colour))];
  return colours.map((colour) => {
    const mine = needs.filter((n) => n.colour === colour);
    const demand = (subset: ColourNeed[]): number => subset.reduce((worst, n) => {
      const s = minSources(shape.deckSize, seenBy(shape, n.turn), n.pips, shape.confidence);
      return Math.max(worst, s);
    }, 0);
    const mustSources = demand(mine.filter((n) => n.must));
    const allSources = demand(mine);
    return {
      colour,
      mustSources,
      allSources,
      wantPremium: allSources - mustSources,
      needsNonLandSources: mustSources > shape.landCount,
    };
  });
}
