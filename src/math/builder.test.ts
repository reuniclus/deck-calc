import { describe, it, expect } from 'vitest';
import { compileFlat, decompileFlat, type FlatQuery } from './builder';
import { printExpr } from './print';
import { parseQuery } from './parse';
import { normalize } from './normalize';
import { and, or, not, atLeast, atLeastKOf, atMost, type Sizes } from './expr';

const SIZES: Sizes = { a: 3, b: 3, c: 2 };
const nameOf = (g: string) => g.toUpperCase();
const resolve = (n: string): string | null => (n.toLowerCase() in SIZES ? n.toLowerCase() : null);

describe('compileFlat -> printExpr -> parseQuery round-trips', () => {
  const cases: FlatQuery[] = [
    { mode: 'and', k: 2, rows: [{ g: 'a', neg: false, lo: 1, hi: null }, { g: 'b', neg: false, lo: 1, hi: null }] },
    { mode: 'or', k: 2, rows: [{ g: 'a', neg: false, lo: 2, hi: null }, { g: 'b', neg: false, lo: 2, hi: null }] },
    { mode: 'atLeastK', k: 2, rows: [{ g: 'a', neg: false, lo: 1, hi: null }, { g: 'b', neg: false, lo: 1, hi: null }, { g: 'c', neg: false, lo: 1, hi: null }] },
    { mode: 'and', k: 2, rows: [{ g: 'a', neg: true, lo: 1, hi: null }, { g: 'b', neg: false, lo: 0, hi: 1 }] },
    { mode: 'and', k: 1, rows: [{ g: 'a', neg: false, lo: 1, hi: 1 }] },
    { mode: 'and', k: 0, rows: [] },
  ];
  for (const fq of cases) {
    it(JSON.stringify(fq), () => {
      const expr = compileFlat(fq);
      const text = printExpr(expr, nameOf);
      const back = parseQuery(text, resolve);
      expect(normalize(back, SIZES)).toEqual(normalize(expr, SIZES));
    });
  }
});

describe('decompileFlat', () => {
  it('is the inverse of compileFlat for every flat case above', () => {
    const cases: FlatQuery[] = [
      { mode: 'and', k: 2, rows: [{ g: 'a', neg: false, lo: 1, hi: null }, { g: 'b', neg: true, lo: 1, hi: null }] },
      { mode: 'or', k: 2, rows: [{ g: 'a', neg: false, lo: 2, hi: null }, { g: 'b', neg: false, lo: 0, hi: 1 }] },
      { mode: 'atLeastK', k: 2, rows: [{ g: 'a', neg: false, lo: 1, hi: null }, { g: 'b', neg: false, lo: 1, hi: null }, { g: 'c', neg: false, lo: 1, hi: null }] },
      { mode: 'and', k: 1, rows: [{ g: 'a', neg: false, lo: 1, hi: 1 }] },
    ];
    for (const fq of cases) {
      const got = decompileFlat(compileFlat(fq));
      expect(got).not.toBeNull();
      expect(got!.mode).toBe(fq.mode);
      expect(got!.rows).toEqual(fq.rows);
    }
  });

  it('refuses genuinely nested expressions rather than guessing', () => {
    expect(decompileFlat(and(or(atLeast('a', 1), atLeast('b', 1)), atLeast('c', 1)))).toBeNull();
    expect(decompileFlat(not(and(atLeast('a', 1), atLeast('b', 1))))).toBeNull();
    expect(decompileFlat(and(atLeast('a', 1), not(and(atLeast('b', 1), atLeast('c', 1)))))).toBeNull();
  });

  it('accepts a single bare atom or a single negated atom', () => {
    expect(decompileFlat(atLeast('a', 2))).toEqual({ mode: 'and', k: 1, rows: [{ g: 'a', neg: false, lo: 2, hi: null }] });
    expect(decompileFlat(not(atMost('a', 1)))).toEqual({ mode: 'and', k: 1, rows: [{ g: 'a', neg: true, lo: 0, hi: 1 }] });
  });

  it('an atLeastK whose kids are themselves compound is refused, not flattened wrongly', () => {
    expect(decompileFlat(atLeastKOf(2, and(atLeast('a', 1), atLeast('b', 1)), atLeast('c', 1)))).toBeNull();
  });
});

describe('range rows survive a full round-trip through TEXT, not just the AST', () => {
  it('a range row printed to text and reparsed still decompiles flat', () => {
    const fq: FlatQuery = { mode: 'atLeastK', k: 2, rows: [
      { g: 'a', neg: false, lo: 1, hi: null },
      { g: 'b', neg: false, lo: 1, hi: 3 }, // the case that broke: prints as "b>=1 & b<=3"
    ] };
    const printed = printExpr(compileFlat(fq), nameOf);
    const reparsed = parseQuery(printed, resolve);
    const back = decompileFlat(reparsed);
    expect(back).not.toBeNull();
    expect(back).toEqual(fq);
  });

  it('a range row alone (not inside atLeastK/OR) also survives', () => {
    const fq: FlatQuery = { mode: 'and', k: 1, rows: [{ g: 'a', neg: false, lo: 2, hi: 3 }] };
    const back = decompileFlat(parseQuery(printExpr(compileFlat(fq), nameOf), resolve));
    expect(back).toEqual(fq);
  });
});
