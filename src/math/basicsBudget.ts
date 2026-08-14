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
 *     B <= k*L - R
 *
 * It reproduces how decks are actually built, which is the reason to trust it: 2-colour
 * with duals allows more basics than there are lands (so all basics are fine); 4-colour
 * with duals allows 4; 5-colour with duals is INFEASIBLE at -14, which is exactly why
 * five-colour decks run rainbows and fetches rather than duals.
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
  const raw = supply - demand;
  return {
    demand,
    supply,
    maxBasics: Math.max(0, Math.min(landCount, raw)),
    infeasible: raw < 0,
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
