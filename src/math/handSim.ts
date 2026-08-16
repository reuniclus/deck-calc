/**
 * Hand-level simulation with mulligans and PROPER colour matching.
 *
 * This exists because source-counting overstates basics badly, and the gap is not small.
 * On a real Bant list at 38 lands, `coverage` scored a duals manabase and a basics-only
 * one within a couple of points, while simulating actual hands gave mulligan rates of
 * 25.8% against 63.6% and "every spell in hand castable" of 63.2% against 25.4%.
 *
 * Two things source-counting cannot see, and both favour non-basics:
 *
 *  1. **Joint availability in ONE hand.** `minSources` asks "is there at least one source
 *     of colour c among the cards seen", independently per colour. It never asks whether a
 *     single seven-card hand holds all three at once.
 *  2. **One land cannot pay two pips.** A `{W}{U}{G}` card needs three separate lands;
 *     source-counting counts one Triome toward all three requirements simultaneously.
 *
 * A dual or triome answers both at once -- one card contributing to several colour needs
 * IN THE SAME HAND -- while a basic contributes to exactly one. Source counting treats
 * those as nearly equivalent. Hands do not.
 *
 * So: use `minSources`/`coverage` for single-colour requirements and for comparing similar
 * manabases; use THIS for any basics-versus-nonbasics decision.
 */

export interface SimLand {
  kind: 'land';
  colours: string[];
  /**
   * How many MANA SOURCES this card is worth for the screw filter. Normally 1.
   *
   * A bounceland is 2: it produces two mana and returns a land, so it does not cost a
   * land drop. Non-land accelerants (signets, mana creatures, auras) are also modelled
   * as cards of this kind -- the filter is about mana AVAILABLE, not about lands, and
   * counting only lands understated a deck like this one by several points.
   */
  sources?: number;
  /**
   * This land produces only what OTHER lands you control can already produce (Horizon of
   * Progress, Reflecting Pool). It doubles a colour you have; it never adds one you lack.
   *
   * Modelled explicitly because treating it as a rainbow is wrong in exactly the case
   * that matters: it will not fix `{W}{U}` off an all-Plains board, though it will happily
   * pay the second pip of `{W}{W}`.
   */
  derived?: boolean;
  /**
   * Exact mana produced by one tap, when it is more than a single pip of choice.
   * A bounceland is `['W','U']`: it makes one white AND one blue, so it pays `{W}{U}`
   * by itself but cannot pay `{W}{W}`.
   *
   * Distinct from `colours`, which means "one pip, any of these". Conflating the two
   * both undercounts the land in Hall matching and overcounts it in the source filter.
   */
  produces?: string[];
}
export interface SimSpell {
  kind: 'spell';
  pips: Record<string, number>;
  /**
   * Hybrid pips, each satisfiable by ANY colour in its set. `[['W','U']]` is one `{W/U}`.
   * Kept separate from `pips` because a hybrid is strictly easier than a fixed pip and
   * Hall's condition has to see it that way -- treating `{W/U}` as fixed white would
   * overstate the white requirement and understate the deck's flexibility.
   */
  hybrid?: string[][];
}
export type SimCard = SimLand | SimSpell;

/**
 * Hall's condition: can these lands pay these pips, each land tapping for ONE colour?
 *
 * Checked over every subset of the demanded colours, which for three colours is seven
 * tests. This is what stops a single dual being counted twice.
 */
export function castable(
  landsIn: SimLand[], pips: Record<string, number>, hybrid: string[][] = [],
): boolean {
  // Resolve derived lands first: each takes the union of what the NON-derived lands make.
  const fixed = landsIn.filter((l) => l.derived !== true);
  const pool = [...new Set(fixed.flatMap((l) => l.colours))];
  const resolved = landsIn.map((l) => (l.derived === true ? { ...l, colours: pool } : l));
  // A land with `produces` is expanded into one virtual land per pip it makes, so a
  // bounceland genuinely pays two different pips at once.
  const lands: SimLand[] = resolved.flatMap((l) => (l.produces === undefined
    ? [l]
    : l.produces.map((c) => ({ kind: 'land' as const, colours: [c] }))));
  // Expand to a list of demands, each a SET of acceptable colours: a fixed pip is a
  // singleton set, a hybrid is its options. Hall's condition then runs over subsets of
  // DEMANDS rather than subsets of colours, which is what lets a hybrid count toward
  // whichever colour is actually available.
  const demands: string[][] = [];
  for (const [c, n] of Object.entries(pips)) for (let i = 0; i < n; i++) demands.push([c]);
  for (const h of hybrid) demands.push([...h]);
  if (lands.length < demands.length) return false;
  for (let mask = 1; mask < (1 << demands.length); mask++) {
    const subset = demands.filter((_, i) => (mask & (1 << i)) !== 0);
    const accepted = new Set(subset.flat());
    const supply = lands.filter((l) => l.colours.some((x) => accepted.has(x))).length;
    if (subset.length > supply) return false;
  }
  return true;
}

export interface SimResult {
  mulliganRate: number;
  /** Fraction of kept hands discarded as mana-screwed, below `minSources`. */
  screwRate: number;
  /** Fraction of kept hands holding a source of the required keep colour. */
  keepColourInHand: number;
  /** Fraction of kept hands where EVERY coloured spell held is castable. */
  everySpellCastable: number;
  /** Fraction where at least one coloured spell is castable. */
  anySpellCastable: number;
  /** Hands scored, i.e. kept and not screwed. */
  scored: number;
}

export interface SimOptions {
  /** Colour a hand must be able to produce, or it is mulliganed. */
  keepColour?: string;
  /** London-style: mulligan down to this many times. */
  maxMulligans?: number;
  runs?: number;
  /** Deterministic seed; omit for Math.random. */
  seed?: number;
  /**
   * Hands with fewer mana sources than this are EXCLUDED from the colour metrics rather
   * than counted as failures. A two-land hand tells you nothing about colour fixing -- it
   * is mana screw, a separate axis -- and leaving it in drags every composition toward
   * the same number and hides the colour signal.
   */
  minSources?: number;
}

function rng(seed?: number): () => number {
  if (seed === undefined) return Math.random;
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Simulate opening hands with mulligans over a 99-card library. */
export function simulateHands(library: SimCard[], opts: SimOptions = {}): SimResult {
  const runs = opts.runs ?? 100000;
  const maxMull = opts.maxMulligans ?? 2;
  const rand = rng(opts.seed);
  const minSrc = opts.minSources ?? 0;
  let mulls = 0, keepColour = 0, castAll = 0, castSome = 0, screwed = 0, scored = 0;
  for (let r = 0; r < runs; r++) {
    let hand: SimCard[] = [];
    let size = 7;
    for (let m = 0; m <= maxMull; m++) {
      const lib = library.slice();
      for (let k = lib.length - 1; k > 0; k--) {
        const j = Math.floor(rand() * (k + 1));
        [lib[k], lib[j]] = [lib[j]!, lib[k]!];
      }
      hand = lib.slice(0, size);
      const ok = opts.keepColour === undefined
        || hand.some((c) => c.kind === 'land' && c.colours.includes(opts.keepColour!));
      if (ok || m === maxMull) { if (m > 0) mulls++; break; }
      size--;
    }
    const lands = hand.filter((c): c is SimLand => c.kind === 'land');
    const kc = opts.keepColour;
    if (kc === undefined || lands.some((l) => l.colours.includes(kc))) keepColour++;
    if (lands.reduce((a, l) => a + (l.sources ?? 1), 0) < minSrc) { screwed++; continue; }
    scored++;
    const spells = hand.filter(
      (c): c is SimSpell => c.kind === 'spell'
        && (Object.keys(c.pips).length > 0 || (c.hybrid?.length ?? 0) > 0),
    );
    if (spells.length === 0) { castAll++; castSome++; continue; }
    const ok = spells.filter((s) => castable(lands, s.pips, s.hybrid ?? [])).length;
    if (ok === spells.length) castAll++;
    if (ok > 0) castSome++;
  }
  return {
    mulliganRate: mulls / runs,
    screwRate: screwed / runs,
    keepColourInHand: keepColour / runs,
    everySpellCastable: scored > 0 ? castAll / scored : 0,
    anySpellCastable: scored > 0 ? castSome / scored : 0,
    scored,
  };
}

/** Convenience: `n` copies of a land producing `colours`. */
export function lands(n: number, ...colours: string[]): SimLand[] {
  return Array.from({ length: n }, () => ({ kind: 'land' as const, colours: [...colours] }));
}

/** A land that only produces what your other lands already produce. */
export function derivedLands(n: number): SimLand[] {
  return Array.from({ length: n }, () => ({ kind: 'land' as const, colours: [], derived: true }));
}

/** A source worth more than one mana, such as a bounceland. */
export function multiSource(n: number, sources: number, ...colours: string[]): SimLand[] {
  return Array.from({ length: n }, () => ({ kind: 'land' as const, colours: [...colours], sources }));
}

/** A land producing several specific pips in one tap, e.g. a bounceland's `{W}{U}`. */
export function producesLands(n: number, ...produces: string[]): SimLand[] {
  return Array.from({ length: n }, () => ({
    kind: 'land' as const, colours: [...new Set(produces)], produces: [...produces],
    sources: produces.length,
  }));
}

/** Pad a card list to `size` with blank spells. */
export function padLibrary(cards: SimCard[], size = 99): SimCard[] {
  const out = cards.slice();
  while (out.length < size) out.push({ kind: 'spell', pips: {} });
  return out;
}

/**
 * UNCONDITIONAL first-hand quality: the metric that basics-versus-nonbasics decisions
 * must use.
 *
 * The conditioned metric (`simulateHands`, which scores only KEPT hands) systematically
 * hides the cost of cutting a colour's sources, because hands lacking that colour are
 * mulliganed away and re-rolled before being scored. On a real Bant list it reported
 * cutting six Selesnya duals as costing 0.16pt when the true cost was 9.3 points of
 * directly-keepable hands, and it showed a FLAT mulligan rate throughout -- which should
 * have been the tell.
 *
 * So this scores the opening seven with no mulligan and no conditioning, splitting the
 * outcomes three ways. The middle bucket is the one the conditioned metric discards.
 */
export interface FirstHandStats {
  /** Cards the castability check saw, i.e. 7 plus any lookahead. */
  cardsSeen: number;
  /** Castable AND holds the required colour: directly keepable. */
  keepable: number;
  /** Castable BUT lacks the required colour, so it gets mulliganed. The hidden cost. */
  castableButMulliganed: number;
  /** Colours cannot be paid. */
  notCastable: number;
  /** Excluded as mana screw, below `minSources`. */
  screwed: number;
  /**
   * Mean fraction of the coloured cards held that are individually castable.
   *
   * This, not `keepable`, is the metric that behaves sensibly as more cards are seen.
   * Requiring EVERY card to be castable gets harder the more you draw -- one extra
   * double-blue card can fail a hand that was fine -- which made a ten-card frame score
   * below a seven-card one for the same manabase. Cards are cast on different turns, so
   * each only needs its own pips payable, and the honest summary is the share that are.
   */
  fractionCastable: number;
  /** Of hands failing at least one card, which colour was short. Sums over hands. */
  missing: Record<string, number>;
  /** Castable-but-green-less hands, i.e. thrown away purely for lacking the keep colour. */
  thrownForKeepColour: number;
}

export function firstHandQuality(
  library: SimCard[],
  opts: {
    keepColour: string; minSources?: number; runs?: number; seed?: number;
    /**
     * Extra cards drawn AFTER the keep decision. The mulligan is still judged on the
     * opening seven -- you decide with what you can see -- but castability is judged on
     * seven plus this many, which is what actually matters: a hand kept for its green
     * source has three draw steps to find the rest.
     *
     * `0` reproduces the frozen-opener metric.
     */
    lookahead?: number;
  },
): FirstHandStats {
  const runs = opts.runs ?? 100000;
  const minSrc = opts.minSources ?? 3;
  const rand = rng(opts.seed);
  let keepable = 0, castableNoColour = 0, notCastable = 0, screwed = 0, fracSum = 0;
  const missing: Record<string, number> = {};
  for (let r = 0; r < runs; r++) {
    const d = library.slice();
    for (let k = d.length - 1; k > 0; k--) {
      const j = Math.floor(rand() * (k + 1));
      [d[k], d[j]] = [d[j]!, d[k]!];
    }
    const opener = d.slice(0, 7);
    // The KEEP decision uses only the opening seven.
    const openerLands = opener.filter((c): c is SimLand => c.kind === 'land');
    const hasColour = openerLands.some((l) => l.colours.includes(opts.keepColour));
    // Castability is judged after the lookahead draws.
    const hand = d.slice(0, 7 + (opts.lookahead ?? 0));
    const handLands = hand.filter((c): c is SimLand => c.kind === 'land');
    const sourceCount = handLands.reduce((a, l) => a + (l.sources ?? 1), 0);
    if (sourceCount < minSrc) { screwed++; continue; }
    const spells = hand.filter(
      (c): c is SimSpell => c.kind === 'spell'
        && (Object.keys(c.pips).length > 0 || (c.hybrid?.length ?? 0) > 0),
    );
    const good = spells.filter((s) => castable(handLands, s.pips, s.hybrid ?? []));
    const ok = spells.length === 0 || good.length === spells.length;
    fracSum += spells.length === 0 ? 1 : good.length / spells.length;
    if (good.length < spells.length) {
      // attribute the shortfall: one more source of which colour would fix the most?
      for (const c of ['W', 'U', 'G']) {
        const probe: SimLand[] = [...handLands, { kind: 'land', colours: [c] }];
        const fixed = spells.filter((s) => castable(probe, s.pips, s.hybrid ?? [])).length;
        if (fixed > good.length) missing[c] = (missing[c] ?? 0) + 1;
      }
    }
    if (ok && hasColour) keepable++;
    else if (ok) castableNoColour++;
    else notCastable++;
  }
  const scored = runs - screwed;
  const scored2 = runs - screwed;
  return {
    cardsSeen: 7 + (opts.lookahead ?? 0),
    fractionCastable: scored2 > 0 ? fracSum / scored2 : 0,
    missing: Object.fromEntries(Object.entries(missing)
      .map(([k, v]) => [k, scored2 > 0 ? v / scored2 : 0])),
    thrownForKeepColour: scored2 > 0 ? castableNoColour / scored2 : 0,
    keepable: scored > 0 ? keepable / scored : 0,
    castableButMulliganed: scored > 0 ? castableNoColour / scored : 0,
    notCastable: scored > 0 ? notCastable / scored : 0,
    screwed: screwed / runs,
  };
}

export interface SwapOption {
  /** Land type cut. */
  cut: string;
  /** Basic added. */
  add: string;
  keepable: number;
  /** Change in keepable hands versus the current composition. */
  deltaPt: number;
}

/**
 * Every (dual to cut, basic to add) pairing, scored and ranked.
 *
 * Reported in full rather than as a single recommendation, because the ORDERING is the
 * useful part: it shows which duals are redundant in this particular deck and which basic
 * the deck is actually short of, and those are rarely what a source count suggests.
 */
export function rankSwaps(
  build: (cuts: Record<string, number>, adds: Record<string, number>) => SimCard[],
  cutTypes: string[],
  addTypes: string[],
  opts: { keepColour: string; minSources?: number; runs?: number; seed?: number },
): SwapOption[] {
  const baseline = firstHandQuality(build({}, {}), opts).keepable;
  const out: SwapOption[] = [];
  for (const cut of cutTypes) {
    for (const add of addTypes) {
      const k = firstHandQuality(build({ [cut]: 1 }, { [add]: 1 }), opts).keepable;
      out.push({ cut, add, keepable: k, deltaPt: (k - baseline) * 100 });
    }
  }
  return out.sort((a, b) => b.deltaPt - a.deltaPt);
}
