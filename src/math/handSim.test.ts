import { describe, expect, it } from 'vitest';
import { castable, lands, padLibrary, simulateHands, type SimCard, type SimLand } from './handSim';

/** W-biased Bant spell base used for every swap measurement below. */
const SPELLS: SimCard[] = [
  ...Array.from({ length: 18 }, () => ({ kind: 'spell' as const, pips: { W: 1 } })),
  ...Array.from({ length: 6 }, () => ({ kind: 'spell' as const, pips: { W: 2 } })),
  ...Array.from({ length: 12 }, () => ({ kind: 'spell' as const, pips: { U: 1 } })),
  ...Array.from({ length: 3 }, () => ({ kind: 'spell' as const, pips: { U: 2 } })),
  ...Array.from({ length: 6 }, () => ({ kind: 'spell' as const, pips: { G: 1 } })),
  ...Array.from({ length: 6 }, () => ({ kind: 'spell' as const, pips: { W: 1, U: 1 } })),
  ...Array.from({ length: 4 }, () => ({ kind: 'spell' as const, pips: { W: 1, G: 1 } })),
  ...Array.from({ length: 2 }, () => ({ kind: 'spell' as const, pips: { W: 1, U: 1, G: 1 } })),
];

describe('Hall matching', () => {
  it('one dual cannot pay two pips', () => {
    // The whole reason source-counting overstates basics: a WU dual counts toward W and U
    // separately, but taps once.
    const wu: SimLand[] = lands(1, 'W', 'U');
    expect(castable(wu, { W: 1 })).toBe(true);
    expect(castable(wu, { U: 1 })).toBe(true);
    expect(castable(wu, { W: 1, U: 1 })).toBe(false);
    expect(castable([...wu, ...lands(1, 'W')], { W: 1, U: 1 })).toBe(true);
  });

  it('a triome cannot alone cast a three-colour card', () => {
    expect(castable(lands(1, 'W', 'U', 'G'), { W: 1, U: 1, G: 1 })).toBe(false);
    expect(castable(lands(3, 'W', 'U', 'G'), { W: 1, U: 1, G: 1 })).toBe(true);
  });

  it('catches the subset case, not just the total', () => {
    // Three lands, three pips, but two of the pips can only come from one land.
    const l: SimLand[] = [...lands(1, 'U'), ...lands(2, 'W')];
    expect(castable(l, { U: 2, W: 1 })).toBe(false);
    expect(castable(l, { U: 1, W: 2 })).toBe(true);
  });
});

describe('duals versus basics, at hand level', () => {
  const withDuals = padLibrary([
    ...lands(7, 'W', 'U', 'G'), ...lands(10, 'W', 'U'), ...lands(6, 'W', 'G'),
    ...lands(3), ...lands(4, 'W'), ...lands(4, 'U'), ...lands(4, 'G'), ...SPELLS,
  ]);
  const basicsOnly = padLibrary([
    ...lands(3), ...lands(18, 'W'), ...lands(11, 'U'), ...lands(6, 'G'), ...SPELLS,
  ]);

  it('source-counting understates the gap dramatically', () => {
    const a = simulateHands(withDuals, { keepColour: 'G', runs: 40000, seed: 7 });
    const b = simulateHands(basicsOnly, { keepColour: 'G', runs: 40000, seed: 7 });
    // coverage scored these within a couple of points; hands do not agree
    expect(b.mulliganRate).toBeGreaterThan(a.mulliganRate * 2);
    expect(a.everySpellCastable).toBeGreaterThan(b.everySpellCastable * 2);
  }, 120000);
});

describe('hybrid pips', () => {
  it('a hybrid is satisfied by either colour', () => {
    expect(castable(lands(1, 'W'), {}, [['W', 'U']])).toBe(true);
    expect(castable(lands(1, 'U'), {}, [['W', 'U']])).toBe(true);
    expect(castable(lands(1, 'G'), {}, [['W', 'U']])).toBe(false);
  });

  it('a hybrid still needs its OWN land -- no double-tapping', () => {
    // {W}{W/U} off one Plains must fail: one land, two demands.
    expect(castable(lands(1, 'W'), { W: 1 }, [['W', 'U']])).toBe(false);
    expect(castable(lands(2, 'W'), { W: 1 }, [['W', 'U']])).toBe(true);
  });

  it('is strictly easier than the equivalent fixed pip', () => {
    // Two blue lands cast {U}{W/U} but not {U}{W}.
    expect(castable(lands(2, 'U'), { U: 1 }, [['W', 'U']])).toBe(true);
    expect(castable(lands(2, 'U'), { U: 1, W: 1 })).toBe(false);
  });
});
