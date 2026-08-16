import { describe, expect, it } from 'vitest';
import { firstHandQuality } from './handSim';
import { sacredBlink, SACRED_BLINK_ACTUAL } from './sacredBlink.fixture';

const OPTS = { keepColour: 'G', minSources: 3, runs: 40000, seed: 8675309 };
const q = (basics: { W: number; U: number; G: number }, cuts: string[] = []) =>
  firstHandQuality(sacredBlink(basics, cuts), OPTS);

describe('sacred blink: basic split', () => {
  it('white is saturated -- Plains are the least valuable basic', () => {
    // 25 of 27 non-basics produce white, so white availability is ~99% before any Plains.
    // The deck's own pip counts say white is heaviest, which is exactly why the naive
    // answer (match basics to pips) is wrong here.
    const actual = q(SACRED_BLINK_ACTUAL).keepable;
    const rebalanced = q({ W: 0, U: 4, G: 6 }).keepable;
    expect(rebalanced).toBeGreaterThan(actual);
    expect((rebalanced - actual) * 100).toBeGreaterThan(2);
  }, 120000);

  it('cutting green basics is what drives the mulligan cost', () => {
    // "castableButMulliganed" is hands that could cast their spells but lack green.
    const greenLight = q({ W: 7, U: 1, G: 2 }).castableButMulliganed;
    const greenHeavy = q({ W: 0, U: 3, G: 7 }).castableButMulliganed;
    expect(greenLight).toBeGreaterThan(greenHeavy * 1.5);
  }, 120000);
});

describe('sacred blink: replacing non-basics with basics', () => {
  it('every cut costs something -- there is no free non-basic', () => {
    // Measured against the REBALANCED baseline so the two effects do not confound.
    const base = q({ W: 0, U: 4, G: 6 }).keepable;
    const cutOne = q({ W: 0, U: 4, G: 7 }, ['Adarkar Wastes']).keepable;
    expect(cutOne).toBeLessThan(base);
  }, 120000);

  it('cutting a colourless land costs less than cutting a dual', () => {
    // Reliquary Tower produces no coloured mana, so replacing it with a basic is close to
    // free; replacing a WU dual is not.
    const cutTower = q({ W: 0, U: 4, G: 7 }, ['Reliquary Tower']).keepable;
    const cutDual = q({ W: 0, U: 4, G: 7 }, ['Glacial Fortress']).keepable;
    expect(cutTower).toBeGreaterThan(cutDual);
  }, 120000);
});
