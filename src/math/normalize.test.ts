import { describe, it, expect } from 'vitest';
import {
  type Expr, type Sizes, atLeast, atMost, exactly, inRange, and, or, not, atLeastKOf,
  TRUE, FALSE, QueryTooLargeError, UnknownGroupError,
} from './expr';
import { normalize } from './normalize';
import { evaluate } from './evaluate';
import { bruteCurve } from './brute';

const IDS = ['a', 'b', 'c'] as const;
const SIZES: Sizes = { a: 3, b: 3, c: 2 };
const N = 18;

/** Direct AST interpretation — deliberately independent of DNF/inclusion-exclusion. */
function interpret(e: Expr, counts: readonly number[], sizes: Sizes): boolean {
  switch (e.t) {
    case 'atom': {
      const i = IDS.indexOf(e.g as typeof IDS[number]);
      const x = counts[i]!;
      return x >= e.lo && x <= (e.hi ?? sizes[e.g]!);
    }
    case 'and': return e.kids.every((k) => interpret(k, counts, sizes));
    case 'or': return e.kids.some((k) => interpret(k, counts, sizes));
    case 'not': return !interpret(e.kid, counts, sizes);
    case 'atLeastK':
      return e.kids.filter((k) => interpret(k, counts, sizes)).length >= e.k;
  }
}

function expectMatchesBruteForce(e: Expr): void {
  const got = evaluate(N, SIZES, normalize(e, SIZES)).curve;
  const want = bruteCurve(N, IDS.map((g) => SIZES[g]!), (c) => interpret(e, c, SIZES));
  for (let n = 0; n <= N; n++) {
    expect(got[n]!, `n=${n}`).toBeCloseTo(want[n]!, 11);
  }
}

describe('normalize + evaluate vs brute force', () => {
  const cases: Array<[string, Expr]> = [
    ['single at-least', atLeast('a', 2)],
    ['plain AND', and(atLeast('a', 1), atLeast('b', 1))],
    ['plain OR', or(atLeast('a', 2), atLeast('b', 2))],
    ['OR of overlapping combos', or(and(atLeast('a', 1), atLeast('b', 1)), atLeast('c', 2))],
    ['NOT of an at-least', not(atLeast('a', 1))],
    ['NOT of an AND (De Morgan)', not(and(atLeast('a', 1), atLeast('b', 1)))],
    ['NOT of an OR', not(or(atLeast('a', 2), atLeast('c', 1)))],
    ['double negation', not(not(atLeast('b', 2)))],
    ['exactly one', exactly('a', 1)],
    ['at most', atMost('b', 1)],
    ['range', inRange('a', 1, 2)],
    ['exactly AND at-least', and(exactly('a', 1), atLeast('b', 1))],
    ['any 2 of 3', atLeastKOf(2, atLeast('a', 1), atLeast('b', 1), atLeast('c', 1))],
    ['any 2 of 3, mixed atoms', atLeastKOf(2, atLeast('a', 2), exactly('b', 1), atMost('c', 0))],
    ['NOT over any-2-of-3', not(atLeastKOf(2, atLeast('a', 1), atLeast('b', 1), atLeast('c', 1)))],
    ['nested', or(and(atLeast('a', 2), not(atLeast('b', 2))), and(exactly('c', 1), atLeast('b', 1)))],
    ['contradiction', and(atLeast('a', 2), atMost('a', 1))],
    ['tautology', or(atMost('a', 1), atLeast('a', 2))],
    ['TRUE', TRUE],
    ['FALSE', FALSE],
    ['deep mix', and(or(atLeast('a', 1), atLeast('b', 1)), not(and(atLeast('a', 1), atLeast('b', 1))))],
  ];
  for (const [name, e] of cases) {
    it(name, () => expectMatchesBruteForce(e));
  }
});

describe('normalize structure', () => {
  it('detects up-sets', () => {
    expect(normalize(and(atLeast('a', 1), atLeast('b', 2)), SIZES).monotone).toBe(true);
    expect(normalize(or(atLeast('a', 1), atLeast('b', 2)), SIZES).monotone).toBe(true);
    expect(normalize(exactly('a', 1), SIZES).monotone).toBe(false);
    expect(normalize(not(atLeast('a', 1)), SIZES).monotone).toBe(false);
    expect(normalize(atMost('a', 2), SIZES).monotone).toBe(false);
  });

  it('collapses a contradiction to zero clauses and a tautology to one empty clause', () => {
    expect(normalize(and(atLeast('a', 2), atMost('a', 1)), SIZES).clauses).toHaveLength(0);
    expect(normalize(TRUE, SIZES).clauses).toEqual([{}]);
    expect(normalize(atLeast('a', 0), SIZES).clauses).toEqual([{}]);
  });

  it('drops clauses subsumed by a weaker sibling', () => {
    // "1+ of a" already covers "2+ of a"
    const d = normalize(or(atLeast('a', 1), atLeast('a', 2)), SIZES);
    expect(d.clauses).toHaveLength(1);
    expect(d.clauses[0]!['a']).toEqual({ lo: 1, hi: 3 });
  });

  it('is idempotent on its own output shape', () => {
    const e = or(and(atLeast('a', 1), atMost('b', 1)), exactly('c', 2));
    const once = normalize(e, SIZES);
    expect(normalize(e, SIZES)).toEqual(once);
  });

  it('atLeastK degenerates correctly', () => {
    const kids = [atLeast('a', 1), atLeast('b', 1), atLeast('c', 1)];
    expect(normalize(atLeastKOf(1, ...kids), SIZES)).toEqual(normalize(or(...kids), SIZES));
    expect(normalize(atLeastKOf(3, ...kids), SIZES)).toEqual(normalize(and(...kids), SIZES));
    expect(normalize(atLeastKOf(4, ...kids), SIZES).clauses).toHaveLength(0);
    expect(normalize(atLeastKOf(0, ...kids), SIZES).clauses).toEqual([{}]);
  });

  it('rejects unknown groups and oversized queries', () => {
    expect(() => normalize(atLeast('zz', 1), SIZES)).toThrow(UnknownGroupError);
    const many = Array.from({ length: 40 }, (_, i) => atLeast(IDS[i % 3]!, 1));
    expect(() => normalize(atLeastKOf(20, ...many), SIZES)).toThrow(QueryTooLargeError);
  });
});
