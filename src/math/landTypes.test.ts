import { describe, expect, it } from 'vitest';
import { checkSupply, colourSupply, type LandType } from './landTypes';

const basic = (name: string, colour: string, count: number): LandType =>
  ({ name, count, colours: [colour], isBasic: true });

describe('land types with fetches', () => {
  it('THE TRAP: one Island plus ten fetches cannot cast UU', () => {
    // Ten fetches all find the same single Island. Any one of them is as good as an
    // Island for ONE blue pip -- so the source count looks healthy -- but two blue
    // lands can never be on the battlefield. No source count detects this; only
    // counting distinct producers does.
    const types: LandType[] = [
      basic('Island', 'U', 1),
      basic('Plains', 'W', 20),
      { name: 'Strand', count: 10, colours: [], fetches: ['Island', 'Plains'] },
    ];
    const [u] = checkSupply(types, [{ colour: 'U', sources: 11, pips: 2 }]);
    expect(u!.producers).toBe(11);        // 1 Island + 10 fetches: plenty of ACCESS
    expect(u!.meetsSourceCount).toBe(true);
    expect(u!.distinct).toBe(1);          // but only one blue land exists
    expect(u!.hasEnoughDistinct).toBe(false); // so UU is impossible
  });

  it('one pip is fine off a single target, which is why fetches carry splashes', () => {
    const types: LandType[] = [
      basic('Island', 'U', 1),
      basic('Plains', 'W', 20),
      { name: 'Strand', count: 10, colours: [], fetches: ['Island', 'Plains'] },
    ];
    const [u] = checkSupply(types, [{ colour: 'U', sources: 11, pips: 1 }]);
    expect(u!.hasEnoughDistinct).toBe(true);
    expect(u!.meetsSourceCount).toBe(true);
  });

  it('a fetch is not a source for a colour it cannot find', () => {
    const types: LandType[] = [
      basic('Island', 'U', 4),
      basic('Forest', 'G', 4),
      { name: 'Strand', count: 8, colours: [], fetches: ['Island'] }, // blue only
    ];
    const supply = colourSupply(types);
    expect(supply.find((s) => s.colour === 'U')!.producers).toBe(12);
    expect(supply.find((s) => s.colour === 'G')!.producers).toBe(4); // fetches do nothing
    expect(supply.find((s) => s.colour === 'G')!.viaFetches).toBe(0);
  });

  it('zero targets means zero fetch contribution -- the colour set is derived', () => {
    // The stated reason fetch colours cannot be declared: run no Islands and Flooded
    // Strand is not a blue source, however many you play.
    const types: LandType[] = [
      basic('Plains', 'W', 20),
      { name: 'Strand', count: 10, colours: [], fetches: ['Island', 'Plains'] },
    ];
    const supply = colourSupply(types);
    expect(supply.find((s) => s.colour === 'U')).toBeUndefined();
    expect(supply.find((s) => s.colour === 'W')!.producers).toBe(30);
  });

  it('fetch-any covers every colour that has a producer', () => {
    const types: LandType[] = [
      basic('Island', 'U', 3),
      basic('Forest', 'G', 3),
      { name: 'Vista', count: 4, colours: [], fetches: [], fetchesAny: true },
    ];
    const supply = colourSupply(types);
    expect(supply.find((s) => s.colour === 'U')!.producers).toBe(7);
    expect(supply.find((s) => s.colour === 'G')!.producers).toBe(7);
  });

  it('mixes duals and triomes, which a single k could not express', () => {
    const types: LandType[] = [
      basic('Plains', 'W', 4), basic('Island', 'U', 4), basic('Swamp', 'B', 4),
      { name: 'WU dual', count: 4, colours: ['W', 'U'] },
      { name: 'WUB triome', count: 4, colours: ['W', 'U', 'B'] },
    ];
    const supply = colourSupply(types);
    expect(supply.find((s) => s.colour === 'W')!.producers).toBe(12); // 4 + 4 + 4
    expect(supply.find((s) => s.colour === 'B')!.producers).toBe(8);  // 4 + 0 + 4
  });

  it('separates the two failure modes', () => {
    // Enough distinct producers but too few cards finding them, versus the reverse.
    const thin: LandType[] = [basic('Island', 'U', 3)];
    const [a] = checkSupply(thin, [{ colour: 'U', sources: 18, pips: 2 }]);
    expect(a!.hasEnoughDistinct).toBe(true);
    expect(a!.meetsSourceCount).toBe(false);
  });
});
