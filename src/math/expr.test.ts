import { describe, it, expect } from 'vitest';
import {
  atLeast, and, or, not, atLeastKOf, TRUE, pruneGroups, collectGroups,
} from './expr';
import { normalize } from './normalize';
import type { Sizes } from './expr';

const SIZES: Sizes = { a: 3, b: 3, c: 2 };

describe('pruneGroups', () => {
  it('drops a dead atom from an AND (AND identity: true)', () => {
    const e = and(atLeast('a', 1), atLeast('b', 1));
    const pruned = pruneGroups(e, new Set(['b']));
    expect(normalize(pruned, { a: 3 })).toEqual(normalize(atLeast('a', 1), { a: 3 }));
  });

  it('drops a dead atom from an OR (OR identity: false)', () => {
    const e = or(atLeast('a', 1), atLeast('b', 2));
    const pruned = pruneGroups(e, new Set(['b']));
    expect(normalize(pruned, { a: 3 })).toEqual(normalize(atLeast('a', 1), { a: 3 }));
  });

  it('removes every mention, even nested under NOT', () => {
    const e = and(atLeast('a', 1), not(atLeast('b', 1)));
    const pruned = pruneGroups(e, new Set(['b']));
    expect(collectGroups(pruned).has('b')).toBe(false);
    expect(normalize(pruned, { a: 3 })).toEqual(normalize(atLeast('a', 1), { a: 3 }));
  });

  it('drops a dead kid from atLeastK and caps k to the survivors', () => {
    const e = atLeastKOf(2, atLeast('a', 1), atLeast('b', 1), atLeast('c', 1));
    const pruned = pruneGroups(e, new Set(['b']));
    expect(collectGroups(pruned).has('b')).toBe(false);
    expect(normalize(pruned, SIZES)).toEqual(
      normalize(atLeastKOf(2, atLeast('a', 1), atLeast('c', 1)), SIZES));
  });

  it('caps k down when it would otherwise exceed the survivor count', () => {
    const e = atLeastKOf(2, atLeast('a', 1), atLeast('b', 1));
    const pruned = pruneGroups(e, new Set(['b']));
    // only 1 kid survives; "any 2 of 1" would be unsatisfiable, so k is capped to 1
    expect(normalize(pruned, { a: 3 })).toEqual(normalize(atLeast('a', 1), { a: 3 }));
  });

  it('removing every group collapses to TRUE inside an AND context', () => {
    const e = and(atLeast('a', 1));
    expect(pruneGroups(e, new Set(['a']))).toEqual(TRUE);
  });

  it('removing every group collapses to TRUE even inside an OR (unconstrained, not unsatisfiable)', () => {
    const e = or(atLeast('a', 1));
    expect(pruneGroups(e, new Set(['a']))).toEqual(TRUE);
  });

  it('is a no-op when the dead set does not intersect the query', () => {
    const e = and(atLeast('a', 1), atLeast('b', 1));
    expect(collectGroups(pruneGroups(e, new Set(['zzz']))).size).toBe(2);
  });

  it('handles a query that is ONLY the dead group', () => {
    expect(collectGroups(pruneGroups(atLeast('a', 1), new Set(['a']))).size).toBe(0);
  });
});
