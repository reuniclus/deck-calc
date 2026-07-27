import { describe, it, expect } from 'vitest';
import { describeAsThreshold } from './AdvisorStrip';

const nameOf = (g: string) => ({ g0: 'Land' }[g] ?? g);

describe('describeAsThreshold', () => {
  it('detects a real threshold: keep at >=2, mulligan below', () => {
    const strategy = [
      { hand: { g0: 0 }, shouldKeep: false },
      { hand: { g0: 1 }, shouldKeep: false },
      { hand: { g0: 2 }, shouldKeep: true },
      { hand: { g0: 3 }, shouldKeep: true },
      { hand: { g0: 4 }, shouldKeep: true },
    ];
    expect(describeAsThreshold(strategy, ['g0'], nameOf)).toBe('Keep any hand with \u22652 Land, mulligan otherwise.');
  });

  it('returns null for multi-group strategies -- does not force a misleading single-group description', () => {
    const strategy = [{ hand: { g0: 1, g1: 1 }, shouldKeep: true }];
    expect(describeAsThreshold(strategy, ['g0', 'g1'], nameOf)).toBeNull();
  });

  it('returns null when the strategy genuinely is NOT a threshold (non-monotone: 0 keeps, 1 mulligans, 2 keeps)', () => {
    const strategy = [
      { hand: { g0: 0 }, shouldKeep: true },
      { hand: { g0: 1 }, shouldKeep: false },
      { hand: { g0: 2 }, shouldKeep: true },
    ];
    expect(describeAsThreshold(strategy, ['g0'], nameOf)).toBeNull();
  });

  it('reports "mulligan every hand" when nothing is ever worth keeping', () => {
    const strategy = [
      { hand: { g0: 0 }, shouldKeep: false },
      { hand: { g0: 1 }, shouldKeep: false },
    ];
    expect(describeAsThreshold(strategy, ['g0'], nameOf)).toMatch(/Mulligan every hand/);
  });

  it('handles an unsorted input correctly (sorts internally before checking monotonicity)', () => {
    const strategy = [
      { hand: { g0: 3 }, shouldKeep: true },
      { hand: { g0: 0 }, shouldKeep: false },
      { hand: { g0: 1 }, shouldKeep: false },
      { hand: { g0: 2 }, shouldKeep: true },
    ];
    expect(describeAsThreshold(strategy, ['g0'], nameOf)).toBe('Keep any hand with \u22652 Land, mulligan otherwise.');
  });
});
