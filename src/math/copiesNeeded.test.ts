import { describe, expect, it } from 'vitest';
import { copiesNeeded, successCube } from './copiesNeeded';

describe('copies needed (inverse hypergeometric)', () => {
  it('matches the classic 4-of in a 60-card opener', () => {
    // P(at least one of 4 in the top 7 of 60) = 1 - C(56,7)/C(60,7) ~ 0.3995
    const cube = successCube({ deckSize: 60, maxCopies: 4, maxNeeded: 1, maxSeen: 7 });
    expect(cube[4]![1]![7]!).toBeCloseTo(0.3995, 4);
  });

  it('is monotone in copies, in cards seen, and inversely in K', () => {
    const cube = successCube({ deckSize: 60, maxCopies: 12, maxNeeded: 3, maxSeen: 15 });
    for (let k = 1; k <= 3; k++) {
      for (let x = 1; x <= 15; x++) {
        for (let c = k; c < 12; c++) expect(cube[c + 1]![k]![x]!).toBeGreaterThanOrEqual(cube[c]![k]![x]! - 1e-12);
      }
      for (let c = k; c <= 12; c++) {
        for (let x = 1; x < 15; x++) expect(cube[c]![k]![x + 1]!).toBeGreaterThanOrEqual(cube[c]![k]![x]! - 1e-12);
      }
    }
    for (let c = 3; c <= 12; c++) {
      for (let x = 1; x <= 15; x++) expect(cube[c]![2]![x]!).toBeGreaterThanOrEqual(cube[c]![3]![x]! - 1e-12);
    }
  });

  it('finds the fewest copies, and reports the marginal copy', () => {
    const a = copiesNeeded({ deckSize: 60, needed: 1, seen: 7, target: 0.9 });
    expect(a.copies).not.toBeNull();
    expect(a.achieved).toBeGreaterThanOrEqual(0.9);
    expect(a.achievedOneFewer).toBeLessThan(0.9);
    console.log(`>=1 in top 7 of 60 at 90%: ${a.copies} copies (${(a.achieved * 100).toFixed(1)}%, one fewer = ${(a.achievedOneFewer * 100).toFixed(1)}%)`);
    const b = copiesNeeded({ deckSize: 60, needed: 2, seen: 12, target: 0.8 });
    console.log(`>=2 in top 12 of 60 at 80%: ${b.copies} copies (${(b.achieved * 100).toFixed(1)}%, one fewer = ${(b.achievedOneFewer * 100).toFixed(1)}%)`);
  });

  it('returns null when the target is unreachable within the cap', () => {
    const a = copiesNeeded({ deckSize: 60, needed: 3, seen: 2, target: 0.5 });
    expect(a.copies).toBeNull(); // cannot find 3 in 2 cards at any copy count
  });
});
