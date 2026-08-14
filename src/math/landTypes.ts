/**
 * Land types, mixed freely, with fetchlands.
 *
 * Replaces `basicsBudget`'s single `coloursPerNonBasic`, which cannot express a real
 * four-colour manabase (duals AND triomes together) and has no way to talk about
 * fetches at all.
 *
 * ## Fetches do not create colour
 *
 * A fetch contributes the colours of what it can FETCH, so its colour set is DERIVED
 * from the rest of the deck rather than declared: run zero Islands and Flooded Strand is
 * not a blue source.
 *
 * The trap that follows, and the reason fetches need their own rule rather than a colour
 * set: **1 Island plus 10 fetches cannot cast `{U}{U}`.** Every fetch finds the same
 * single Island, so while any fetch is as good as an Island for ONE blue pip, no number
 * of them produces two blue lands. Fetches multiply ACCESS to targets; they do not
 * multiply the targets.
 *
 * So the rule here is:
 *  - `producers[c]` -- cards that put a c-producing land on the battlefield -- counts
 *    direct producers plus every fetch that can find one. This is what a k=1 requirement
 *    cares about, and it is why fetches are so strong for splashes.
 *  - `distinct[c]` -- how many c-producing lands EXIST -- caps how many can be on board
 *    at once. A requirement of `k` pips is unmeetable when `distinct[c] < k`, whatever
 *    the fetch count, and that is reported rather than hidden.
 *
 * Deliberately NOT modelled: fetch tempo (most enter tapped or cost life), deck
 * thinning, and the fact that a fetch drawn late may find a target already drawn. The
 * first two are real but orthogonal; the third makes this a mild ceiling, in the same
 * way the spec's "one spell per turn" note does.
 */

export interface LandType {
  name: string;
  count: number;
  /** Colours this land produces itself. Empty for a fetch, which produces none. */
  colours: string[];
  /** True for a basic -- the thing whose count the budget question is about. */
  isBasic?: boolean;
  /**
   * For a fetch: which land types it can retrieve, by name. A fetch's colours are
   * derived from these, so `['Plains', 'Island']` is a Flooded Strand and `[]` means it
   * can fetch anything (a Prismatic Vista or Fabled Passage).
   */
  fetches?: string[];
  /** True when `fetches: []` should mean "any land" rather than "nothing". */
  fetchesAny?: boolean;
}

export interface ColourSupply {
  colour: string;
  /** Cards that can put a c-producer onto the battlefield: direct producers + fetches. */
  producers: number;
  /** Distinct c-producing lands in the deck. Caps how many can be on board at once. */
  distinct: number;
  /** How much of `producers` comes from fetches rather than direct producers. */
  viaFetches: number;
}

function fetchTargets(fetch: LandType, all: LandType[]): LandType[] {
  if (fetch.fetchesAny) return all.filter((t) => t.colours.length > 0);
  const names = new Set(fetch.fetches ?? []);
  return all.filter((t) => names.has(t.name) && t.colours.length > 0);
}

/** Colour supply for a manabase of mixed types. */
export function colourSupply(types: LandType[]): ColourSupply[] {
  const colours = [...new Set(types.flatMap((t) => t.colours))].sort();
  return colours.map((c) => {
    const direct = types
      .filter((t) => t.colours.includes(c))
      .reduce((a, t) => a + t.count, 0);
    const viaFetches = types
      .filter((t) => (t.fetches !== undefined || t.fetchesAny === true)
        && fetchTargets(t, types).some((g) => g.colours.includes(c)))
      .reduce((a, t) => a + t.count, 0);
    return { colour: c, producers: direct + viaFetches, distinct: direct, viaFetches };
  });
}

export interface SupplyVerdict {
  colour: string;
  /** Sources the requirement asks for. */
  required: number;
  producers: number;
  distinct: number;
  /** Enough cards can find a producer. */
  meetsSourceCount: boolean;
  /**
   * False when fewer c-producing lands EXIST than the requirement needs pips -- the
   * "one Island plus ten fetches" failure, which no source count can fix.
   */
  hasEnoughDistinct: boolean;
}

/**
 * Check a manabase against per-colour requirements. Two separate questions, because a
 * manabase can pass one and fail the other: are there enough cards that FIND the colour,
 * and do enough lands producing it actually EXIST.
 */
export function checkSupply(
  types: LandType[], requirements: Array<{ colour: string; sources: number; pips: number }>,
): SupplyVerdict[] {
  const supply = colourSupply(types);
  return requirements.map((r) => {
    const s = supply.find((x) => x.colour === r.colour)
      ?? { colour: r.colour, producers: 0, distinct: 0, viaFetches: 0 };
    return {
      colour: r.colour,
      required: r.sources,
      producers: s.producers,
      distinct: s.distinct,
      meetsSourceCount: s.producers >= r.sources,
      hasEnoughDistinct: s.distinct >= r.pips,
    };
  });
}
