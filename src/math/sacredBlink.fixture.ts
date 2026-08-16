/**
 * The "sacred blink" deck, saved as a reusable fixture.
 *
 * Sourced from the actual list rather than invented: 38 lands, and pip counts taken from
 * the deck's own statistics -- W 45 pips over 37 cards, U 33 over 27, G 14 over 12, plus
 * 3x {W/U} and one card costing {G/U}{G/U}.
 *
 * Corrections already folded in, each of which moved the answer materially:
 *  - ZERO double-green cards; the two `{U/G}` pips sit on ONE card, not two
 *  - Azorius Chancery counts as TWO mana sources (it returns a land, so no land drop lost)
 *  - the screw filter counts MANA SOURCES, not lands: six non-land accelerants, two of
 *    which fix colour
 *  - Mountain and Swamp are deliberate utility lands and stay
 *  - shrines that are never realistically cast are excluded from the requirement set
 *
 * Remaining inference, and the one input still unverified against the cards: the split of
 * pips ACROSS cards (8 double-white, 6 double-blue). Totals are known; the per-card
 * distribution is derived from totals divided by card counts.
 */
import { derivedLands, lands, producesLands, padLibrary, type SimCard, type SimLand, type SimSpell } from './handSim';

const spell = (pips: Record<string, number>, hybrid?: string[][]): SimSpell =>
  ({ kind: 'spell', pips, ...(hybrid ? { hybrid } : {}) });

export const SACRED_BLINK_SPELLS: SimCard[] = [
  ...Array.from({ length: 24 }, () => spell({ W: 1 })),
  ...Array.from({ length: 8 }, () => spell({ W: 2 })),
  ...Array.from({ length: 16 }, () => spell({ U: 1 })),
  ...Array.from({ length: 6 }, () => spell({ U: 2 })),
  ...Array.from({ length: 10 }, () => spell({ G: 1 })),
  ...Array.from({ length: 3 }, () => spell({ W: 1, U: 1 })),
  ...Array.from({ length: 2 }, () => spell({ W: 1, G: 1 })),
  ...Array.from({ length: 3 }, () => spell({}, [['W', 'U']])),
  spell({}, [['U', 'G'], ['U', 'G']]),
];

/** Non-basic lands in the list. Names kept so a swap can name what it cut. */
export const SACRED_BLINK_NONBASICS: Array<{ name: string; land: SimLand }> = [
  { name: 'Adarkar Wastes', land: lands(1, 'W', 'U')[0]! },
  // Fetches a basic, so in Hall terms it pays one pip of any colour you run a basic of --
  // functionally a rainbow land, NOT colourless.
  { name: 'Ash Barrens', land: lands(1, 'W', 'U', 'G')[0]! },
  // Taps for {W}{U} -- one white AND one blue at once, and returns a land so no land
  // drop is lost. Two sources, two pips, but it cannot pay {W}{W}.
  { name: 'Azorius Chancery', land: producesLands(1, 'W', 'U')[0]! },
  { name: 'Brushland', land: lands(1, 'W', 'G')[0]! },
  { name: 'Canopy Vista', land: lands(1, 'W', 'G')[0]! },
  { name: 'Command Tower', land: lands(1, 'W', 'U', 'G')[0]! },
  { name: 'Deserted Beach', land: lands(1, 'W', 'U')[0]! },
  { name: 'Exotic Orchard', land: lands(1, 'W', 'U', 'G')[0]! },
  { name: 'Fabled Passage', land: lands(1, 'W', 'U', 'G')[0]! },
  { name: 'Fortified Village', land: lands(1, 'W', 'G')[0]! },
  { name: 'Gathering Place', land: lands(1, 'W', 'U')[0]! },
  { name: 'Glacial Fortress', land: lands(1, 'W', 'U')[0]! },
  { name: 'Gleaming Bastion', land: lands(1, 'W', 'U')[0]! },
  { name: 'Hidden Hideout', land: lands(1, 'W', 'U', 'G')[0]! },
  // Produces only what another land you control already makes: doubles a colour, never
  // adds one.
  { name: 'Horizon of Progress', land: derivedLands(1)[0]! },
  { name: 'Kabira Takedown', land: lands(1, 'W')[0]! },
  { name: 'Mystic Gate', land: lands(1, 'W', 'U')[0]! },
  { name: 'Overgrown Farmland', land: lands(1, 'W', 'G')[0]! },
  { name: 'Path of Ancestry', land: lands(1, 'W', 'U', 'G')[0]! },
  { name: 'Port Town', land: lands(1, 'W', 'U')[0]! },
  { name: 'Prairie Stream', land: lands(1, 'W', 'U')[0]! },
  // FIXED SLOT -- not a candidate for replacement, kept for its no-maximum-hand-size
  // effect rather than its mana. Excluded from swap rankings by `SWAPPABLE`.
  { name: 'Reliquary Tower', land: lands(1)[0]! },
  { name: 'Seachrome Coast', land: lands(1, 'W', 'U')[0]! },
  { name: 'Seaside Citadel', land: lands(1, 'W', 'U', 'G')[0]! },
  { name: 'Skycloud Expanse', land: lands(1, 'W', 'U')[0]! },
  { name: 'Sunpetal Grove', land: lands(1, 'W', 'G')[0]! },
  { name: 'Urban Retreat', land: lands(1, 'W', 'U', 'G')[0]! },
];

/** Six non-land mana sources: two fix colour, one makes green, three are colourless. */
export const SACRED_BLINK_OFFLAND: SimLand[] = [
  ...lands(2, 'W', 'U', 'G'), ...lands(1, 'G'), ...lands(3),
];

/** Mountain + Swamp: deliberate utility lands, colourless for casting purposes. */
export const SACRED_BLINK_UTILITY: SimLand[] = lands(2);

export interface Basics { W: number; U: number; G: number }

/** Build the library for a given basic split and an optional set of cut non-basics. */
export function sacredBlink(basics: Basics, cutNames: string[] = []): SimCard[] {
  const cuts = new Map<string, number>();
  for (const n of cutNames) cuts.set(n, (cuts.get(n) ?? 0) + 1);
  const kept: SimLand[] = [];
  for (const { name, land } of SACRED_BLINK_NONBASICS) {
    const c = cuts.get(name) ?? 0;
    if (c > 0) cuts.set(name, c - 1); else kept.push(land);
  }
  return padLibrary([
    ...kept, ...SACRED_BLINK_UTILITY,
    ...lands(basics.W, 'W'), ...lands(basics.U, 'U'), ...lands(basics.G, 'G'),
    ...SACRED_BLINK_OFFLAND, ...SACRED_BLINK_SPELLS,
  ]);
}

/**
 * Lands the deck will not consider cutting, whatever the numbers say. Reliquary Tower is
 * here for its effect, not its mana, so ranking it as a cheap cut is an artefact of a
 * model that only scores colour.
 */
export const SACRED_BLINK_FIXED_SLOTS = ['Reliquary Tower'];

/** Non-basics that may actually be swapped out. */
export const SACRED_BLINK_SWAPPABLE = SACRED_BLINK_NONBASICS
  .map((n) => n.name)
  .filter((n) => !SACRED_BLINK_FIXED_SLOTS.includes(n));

/** The list as actually built: 7 white-producing basics, 1 Island, 2 Forests. */
export const SACRED_BLINK_ACTUAL: Basics = { W: 7, U: 1, G: 2 };
