import { describe, expect, it } from 'vitest';
import { heuristicTable, priceOfBasics, proposeManabase } from './proposeManabase';
import { basicsBudget } from './basicsBudget';
import { EDH } from './manaSources';

const req = (colours: string[], sources: number, pips = 1) =>
  colours.map((colour) => ({ colour, sources, pips }));

describe('proposing a manabase', () => {
  it('proposes a feasible composition and verifies its own proposal', () => {
    // Checked with checkSupply rather than trusting the arithmetic that built it: a
    // greedy answer that passes is useful, one that fails is a bug.
    const p = proposeManabase(38, req(['W', 'U', 'B'], 18), 2);
    expect(p.feasible).toBe(true);
    expect(p.basics).toBe(21);
    expect(p.basics + p.nonBasics).toBe(38);
    expect(p.verdicts.every((v) => v.meetsSourceCount && v.hasEnoughDistinct)).toBe(true);
  });

  it('the identity is an UPPER bound; construction achieves one less', () => {
    // basicsBudget counts colour-slots and ignores integrality and colour assignment,
    // so it says 22 where a real composition reaches 21. The identity is the estimate,
    // the proposal is the answer -- and the gap is expected rather than a defect.
    expect(basicsBudget(38, [18, 18, 18], 2).maxBasics).toBe(22);
    expect(proposeManabase(38, req(['W', 'U', 'B'], 18), 2).basics).toBe(21);
  });

  it('reports infeasible rather than proposing something that fails', () => {
    const p = proposeManabase(38, req(['W', 'U', 'B', 'R', 'G'], 18), 2);
    expect(p.feasible).toBe(false);
  });

  it('broader non-basics allow more basics', () => {
    const duals = proposeManabase(38, req(['W', 'U', 'B'], 18), 2).basics;
    const triomes = proposeManabase(38, req(['W', 'U', 'B'], 18), 3).basics;
    expect(triomes).toBeGreaterThan(duals);
  });
});

describe('pricing basics', () => {
  it('is a staircase, not a slope', () => {
    // With 3 colours it takes 3 basics to cost every colour one source, so castability
    // holds flat then steps. Quoting a per-basic average would misdescribe the shape.
    const rows = priceOfBasics(EDH, 38, 3, 1, 4, 2);
    const at = (b: number) => rows.find((r) => r.basics === b)!;
    expect(at(19).probability).toBeCloseTo(at(21).probability, 9);
    expect(at(22).probability).toBeLessThan(at(21).probability);
    expect((at(21).probability - at(22).probability) * 100).toBeCloseTo(1.49, 1);
  });

  it('prices the whole range, including over-budget counts', () => {
    const rows = priceOfBasics(EDH, 38, 4, 1, 4, 2);
    expect(rows[0]!.hitPt).toBeLessThanOrEqual(0 + 1e-9); // all-nonbasic meets the target
    expect(rows[rows.length - 1]!.hitPt).toBeGreaterThan(10); // all-basic is far short
  });
});

describe('the general heuristic', () => {
  const rows = heuristicTable(EDH, 38, 4);
  const row = (colours: number, k: number) =>
    rows.find((r) => r.colours === colours && r.coloursPerNonBasic === k)!;

  it('2-colour decks can be all basics; 4-colour with duals cannot', () => {
    expect(row(2, 2).maxBasics).toBe(38);
    expect(row(4, 2).maxBasics).toBe(4);
  });

  it('5-colour with duals is infeasible at any basic count', () => {
    // maxBasics < 0 means even zero basics falls short -- the signal that the land TYPES
    // are wrong, not the basic count.
    expect(row(5, 2).maxBasics).toBeLessThan(0);
    expect(row(5, 2).nextBasicPt).toBeGreaterThan(4);
  });

  it('broader lands rescue wider decks', () => {
    expect(row(5, 3).maxBasics).toBeGreaterThan(0);
    expect(row(5, 5).maxBasics).toBeGreaterThan(row(5, 3).maxBasics);
  });

  it('more colours means fewer basics at fixed land breadth', () => {
    expect(row(3, 2).maxBasics).toBeGreaterThan(row(4, 2).maxBasics);
    expect(row(3, 3).maxBasics).toBeGreaterThan(row(4, 3).maxBasics);
  });
});
