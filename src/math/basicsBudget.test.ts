import { describe, expect, it } from 'vitest';
import { basicsBudget, consistencyCost } from './basicsBudget';
import { EDH } from './manaSources';

describe('basics budget', () => {
  const req18 = (n: number) => new Array(n).fill(18) as number[];

  it('reproduces how real decks are built', () => {
    // The reason to trust the identity: it lands on real construction without tuning.
    expect(basicsBudget(38, req18(2), 2).basicsFree).toBe(true);   // 2c: all basics fine
    expect(basicsBudget(38, req18(3), 2).maxBasics).toBe(22);      // 3c duals: a mix
    expect(basicsBudget(38, req18(3), 3).basicsFree).toBe(true);   // triomes free you
    expect(basicsBudget(38, req18(4), 2).maxBasics).toBe(4);       // 4c: nearly all nonbasic
    expect(basicsBudget(38, req18(5), 2).infeasible).toBe(true);   // 5c duals: impossible
    expect(basicsBudget(38, req18(5), 5).basicsFree).toBe(true);   // rainbows: feasible
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
