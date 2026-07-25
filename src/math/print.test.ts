import { describe, it, expect } from 'vitest';
import { printExpr, quoteName } from './print';
import { parseQuery } from './parse';
import { normalize } from './normalize';
import {
  type Expr, type Sizes, atLeast, atMost, exactly, inRange, and, or, not, atLeastKOf, TRUE, FALSE,
} from './expr';

// ids are opaque; display names are deliberately awkward
const SIZES: Sizes = { g0: 4, g1: 3, g2: 2, g3: 5 };
const NAMES: Record<string, string> = {
  g0: 'blink etb', g1: 'Ramp', g2: 'any', g3: 'A-1_x',
};
const nameOf = (g: string) => NAMES[g] ?? '?';
const resolve = (name: string): string | null =>
  Object.keys(NAMES).find((k) => NAMES[k]!.toLowerCase() === name.trim().toLowerCase()) ?? null;

const cases: Array<[string, Expr]> = [
  ['at least', atLeast('g0', 2)],
  ['exactly', exactly('g0', 1)],
  ['at most', atMost('g1', 1)],
  ['range', inRange('g0', 1, 3)],
  ['and', and(atLeast('g0', 1), atLeast('g1', 1))],
  ['or', or(atLeast('g0', 2), atLeast('g1', 2))],
  ['and over or', and(or(atLeast('g0', 1), atLeast('g1', 1)), atLeast('g2', 1))],
  ['or over and', or(and(atLeast('g0', 1), atLeast('g1', 1)), atLeast('g2', 2))],
  ['not atom', not(atLeast('g0', 1))],
  ['not and', not(and(atLeast('g0', 1), atLeast('g1', 1)))],
  ['not or', not(or(atLeast('g0', 1), atLeast('g1', 1)))],
  ['not range', not(inRange('g0', 1, 2))],
  ['any k of', atLeastKOf(2, atLeast('g0', 1), atLeast('g1', 1), atLeast('g2', 1))],
  ['any k of, nested', atLeastKOf(2, and(atLeast('g0', 1), atLeast('g3', 1)), atMost('g1', 0), exactly('g2', 1))],
  ['not any k of', not(atLeastKOf(2, atLeast('g0', 1), atLeast('g1', 1)))],
  ['range inside and', and(inRange('g0', 1, 3), atLeast('g1', 1))],
  ['range inside not', not(and(inRange('g0', 1, 3), atLeast('g1', 1)))],
  ['deep', or(and(atLeast('g0', 2), not(atMost('g1', 0))), and(exactly('g2', 1), inRange('g3', 1, 2))),
  ],
  ['TRUE', TRUE],
  ['FALSE', FALSE],
];

describe('printExpr round-trips through parseQuery', () => {
  for (const [name, e] of cases) {
    it(name, () => {
      const text = printExpr(e, nameOf);
      const back = parseQuery(text, resolve);
      // Compare normalized forms: printing may pick a different but equivalent spelling.
      expect(normalize(back, SIZES), text).toEqual(normalize(e, SIZES));
    });
  }
});

describe('quoteName', () => {
  it('quotes names that would lex as something else', () => {
    expect(quoteName('Ramp')).toBe('Ramp');
    expect(quoteName('A-1_x')).toBe('A-1_x');
    expect(quoteName('blink etb')).toBe('"blink etb"');
    expect(quoteName('any')).toBe('"any"');
    expect(quoteName('not')).toBe('"not"');
    expect(quoteName('true')).toBe('"true"');
    expect(quoteName('2drop')).toBe('"2drop"');
    expect(quoteName('')).toBe('""');
  });
});

describe('renaming a group does not change the query', () => {
  it('re-prints with the new name and evaluates identically', () => {
    const e = and(atLeast('g0', 1), atMost('g1', 1));
    const before = printExpr(e, nameOf);
    expect(before).toContain('"blink etb"');

    const renamed: Record<string, string> = { ...NAMES, g0: 'flicker' };
    const after = printExpr(e, (g) => renamed[g] ?? '?');
    expect(after).toContain('flicker');
    expect(after).not.toContain('blink');

    const reResolve = (n: string): string | null =>
      Object.keys(renamed).find((k) => renamed[k]!.toLowerCase() === n.trim().toLowerCase()) ?? null;
    expect(normalize(parseQuery(after, reResolve), SIZES)).toEqual(normalize(e, SIZES));
  });
});
