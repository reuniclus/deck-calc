import { describe, it, expect } from 'vitest';
import { parseQuery, ParseError } from './parse';
import { normalize } from './normalize';
import { evaluate } from './evaluate';
import { atLeast, atMost, exactly, and, or, not, type Sizes } from './expr';

const SIZES: Sizes = { a: 3, b: 3, c: 2, 'blue mana': 4 };
const resolve = (name: string): string | null => {
  const k = name.toLowerCase();
  return k in SIZES ? k : null;
};
const p = (s: string) => normalize(parseQuery(s, resolve), SIZES);
const same = (s: string, e: Parameters<typeof normalize>[0]) =>
  expect(p(s)).toEqual(normalize(e, SIZES));

describe('parseQuery', () => {
  it('parses comparison operators', () => {
    same('a>=2', atLeast('a', 2));
    same('a > 1', atLeast('a', 2));
    same('a<=1', atMost('a', 1));
    same('a < 2', atMost('a', 1));
    same('a=1', exactly('a', 1));
    same('a == 1', exactly('a', 1));
  });

  it('treats a bare name as at-least-one', () => same('a', atLeast('a', 1)));

  it('handles precedence: ! then & then |', () => {
    same('a & b | c', or(and(atLeast('a', 1), atLeast('b', 1)), atLeast('c', 1)));
    same('(a | b) & c', and(or(atLeast('a', 1), atLeast('b', 1)), atLeast('c', 1)));
    same('!a & b', and(not(atLeast('a', 1)), atLeast('b', 1)));
  });

  it('accepts word operators and && ||', () => {
    same('a and b', and(atLeast('a', 1), atLeast('b', 1)));
    same('a or b', or(atLeast('a', 1), atLeast('b', 1)));
    same('a && b', and(atLeast('a', 1), atLeast('b', 1)));
    same('a || b', or(atLeast('a', 1), atLeast('b', 1)));
    same('not a', not(atLeast('a', 1)));
  });

  it('has no "any k of" shorthand — write an explicit OR instead', () => {
    expect(() => p('any 2 of (a, b)')).toThrow(/unknown group/);
  });

  it('parses quoted multi-word names without keyword collisions', () => {
    same('"blue mana">=2', atLeast('blue mana', 2));
    expect(() => p('"any">=1')).toThrow(ParseError); // quoted -> looked up, not a keyword
  });

  it('produces usable probabilities end to end', () => {
    const r = evaluate(40, SIZES, p('a>=1 & b>=1'));
    expect(r.curve[7]!).toBeGreaterThan(0);
    expect(r.curve[40]!).toBeCloseTo(1, 12);
    expect(r.monotone).toBe(true);
  });

  it('reports errors with a position', () => {
    expect(() => p('a >= ')).toThrow(ParseError);
    expect(() => p('zzz>=1')).toThrow(/unknown group/);
    expect(() => p('(a')).toThrow(ParseError);
    expect(() => p('a &')).toThrow(ParseError);
    expect(() => p('')).toThrow(/empty query/);
    expect(() => p('a b')).toThrow(/trailing/);
    try { p('a >= x'); } catch (e) { expect((e as ParseError).pos).toBeGreaterThan(0); }
  });
});
