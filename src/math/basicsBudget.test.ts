import { describe, expect, it } from 'vitest';
import { basicsBudget, colourRequirements, consistencyCost, seenBy, type DeckShape } from './basicsBudget';
import { EDH } from './manaSources';

describe('basics budget', () => {
  const req18 = (n: number) => new Array(n).fill(18) as number[];

  it('reproduces how real decks are built (L=38, 1-pip requirements)', () => {
    // Every number here is specific to L=38 AND req=18 (one pip by turn 4). Both are
    // inputs, not constants -- see the land-count sweep below.
    expect(basicsBudget(38, req18(2), 2).basicsFree).toBe(true);   // 2c: all basics fine
    expect(basicsBudget(38, req18(3), 2).maxBasics).toBe(22);      // 3c duals: a mix
    expect(basicsBudget(38, req18(3), 3).maxBasics).toBe(30);      // 3c triomes: NOT free
    expect(basicsBudget(38, req18(4), 2).maxBasics).toBe(4);       // 4c duals: nearly none
    expect(basicsBudget(38, req18(4), 3).maxBasics).toBe(21);      // 4c triomes
    expect(basicsBudget(38, req18(5), 2).infeasible).toBe(true);   // 5c duals: impossible
    expect(basicsBudget(38, req18(5), 5).maxBasics).toBe(25);      // 5c rainbows: NOT free
  });

  it('the divisor matters: a basic displaces a k-colour land', () => {
    // Regression for a real bug. The first version used B <= k*L - R, which coincides
    // with the truth at k=2 and is badly wrong above it -- it claimed 3c triomes allowed
    // 60 basics (more than the deck has lands) instead of 30.
    for (const [k, colours] of [[3, 3], [3, 4], [5, 5]] as const) {
      const b = basicsBudget(38, req18(colours), k);
      // verify by construction rather than by formula
      const supply = b.maxBasics + (38 - b.maxBasics) * k;
      expect(supply).toBeGreaterThanOrEqual(b.demand);
      const oneMore = (b.maxBasics + 1) + (38 - b.maxBasics - 1) * k;
      if (b.maxBasics < 38) expect(oneMore).toBeLessThan(b.demand);
    }
  });

  it('land count is an input, and the slope is k/(k-1)', () => {
    // At k=2 each extra land buys TWO basics, so a one-land change swings the answer by
    // half in a tight deck. This is why L must never be hard-coded.
    expect(basicsBudget(37, req18(4), 2).maxBasics).toBe(2);
    expect(basicsBudget(38, req18(4), 2).maxBasics).toBe(4);
    expect(basicsBudget(39, req18(4), 2).maxBasics).toBe(6);
  });

  it('is monotone in land count and in colour breadth', () => {
    expect(basicsBudget(40, req18(3), 2).maxBasics)
      .toBeGreaterThan(basicsBudget(36, req18(3), 2).maxBasics);
    expect(basicsBudget(38, req18(4), 2).maxBasics)
      .toBeLessThan(basicsBudget(38, req18(3), 2).maxBasics);
  });

  it('prices going over budget, and the price accelerates', () => {
    // 1 pip by T4 in EDH requires 18 sources. Each source below that costs more than
    // the last -- which is the shape a single "infeasible" verdict hides.
    const rows = consistencyCost(EDH, 1, 4, 18, 13);
    expect(rows[0]!.sources).toBe(18);
    expect(rows[0]!.costPt).toBeCloseTo(0, 6);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.costPt).toBeGreaterThan(rows[i - 1]!.costPt);
    }
    const steps = rows.slice(1).map((r, i) => r.costPt - rows[i]!.costPt);
    expect(steps[steps.length - 1]!).toBeGreaterThan(steps[0]!);
    console.log(rows.map((r) => `${r.sources}src=${(r.probability * 100).toFixed(1)}% (-${r.costPt.toFixed(1)}pt)`).join('  '));
  });

  it('a heavier pip requirement is MORE forgiving per source, not less', () => {
    // Counterintuitive and worth pinning. Dropping two sources costs 3.19pt at one pip
    // but only 2.75pt at two pips -- even though two pips needs 30 sources against 18.
    // At 30 sources you already hold 30% of the deck, where the tail is flatter, so the
    // marginal source is worth less. The practical reading: heavy requirements are
    // expensive to MEET and cheap to shave, while light ones are the opposite.
    const one = consistencyCost(EDH, 1, 4, 18, 16);
    const two = consistencyCost(EDH, 2, 4, 30, 28);
    expect(two[2]!.costPt).toBeLessThan(one[2]!.costPt);
    expect(one[2]!.costPt).toBeCloseTo(3.19, 1);
    expect(two[2]!.costPt).toBeCloseTo(2.75, 1);
  });
});


describe('real deck shapes', () => {
  // Deck A: 38 lands, the hard requirement is three green pips by turn 4.
  const deckA: DeckShape = {
    deckSize: 99, landCount: 38, openingHand: 7, drawsOnFirstTurn: true, confidence: 0.9,
  };
  // Deck B: 30 lands but heavy card draw, and the only requirement is one G and one W
  // by turn 3. Fewer lands, far weaker colour demands.
  const deckB: DeckShape = {
    deckSize: 99, landCount: 30, openingHand: 7, drawsOnFirstTurn: true, confidence: 0.9,
    extraDrawPerTurn: 1.5,
  };

  it('deck A: 3 green pips by T4 needs more sources than it has lands', () => {
    const [g] = colourRequirements(deckA, [{ colour: 'G', pips: 3, turn: 4, must: true }]);
    expect(g!.mustSources).toBe(40);
    // 40 > 38: no land-only manabase reaches it, however it is built. Rocks or dorks
    // are mandatory, and saying so is more useful than reporting an impossible budget.
    expect(g!.needsNonLandSources).toBe(true);
  });

  it('deck B: card draw genuinely lowers the requirement', () => {
    const needs = [
      { colour: 'G', pips: 1, turn: 3, must: true },
      { colour: 'W', pips: 1, turn: 3, must: true },
    ];
    const withDraw = colourRequirements(deckB, needs);
    const withoutDraw = colourRequirements({ ...deckB, extraDrawPerTurn: 0 }, needs);
    expect(seenBy(deckB, 3)).toBeGreaterThan(seenBy({ ...deckB, extraDrawPerTurn: 0 }, 3));
    expect(withDraw[0]!.mustSources).toBeLessThan(withoutDraw[0]!.mustSources);
    expect(withDraw[0]!.needsNonLandSources).toBe(false);
    console.log(`deck B: G needs ${withDraw[0]!.mustSources} sources with draw, ${withoutDraw[0]!.mustSources} without`);
  });

  it('a want costs less than a must: the splash no longer dictates', () => {
    // The failure case from the review: one off-colour card previously demanded full
    // support. Marked as a want, it is priced instead of enforced.
    const needs = [
      { colour: 'G', pips: 1, turn: 3, must: true },
      { colour: 'U', pips: 1, turn: 5, must: false },
    ];
    const reqs = colourRequirements(deckA, needs);
    const blue = reqs.find((r) => r.colour === 'U')!;
    expect(blue.mustSources).toBe(0);          // nothing forced
    expect(blue.allSources).toBeGreaterThan(0); // but the price is reported
    expect(blue.wantPremium).toBe(blue.allSources);
  });
});
