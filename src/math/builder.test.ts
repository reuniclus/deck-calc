import { describe, it, expect } from 'vitest';
import { compileFlat, decompileFlat, type FlatQuery } from './builder';
import { printExpr } from './print';
import { parseQuery } from './parse';
import { normalize } from './normalize';
import { and, or, not, atLeast, atLeastKOf, atMost, type Sizes } from './expr';

const SIZES: Sizes = { a: 3, b: 3, c: 2 };
const nameOf = (g: string) => g.toUpperCase();
const resolve = (n: string): string | null => (n.toLowerCase() in SIZES ? n.toLowerCase() : null);

const R = (g: string, lo: number, hi: number | null, neg = false) => ({ g, neg, lo, hi });
const noClauses = { clauses: [] as { rows: ReturnType<typeof R>[] }[] };

describe('compileFlat -> printExpr -> parseQuery round-trips', () => {
  const cases: FlatQuery[] = [
    { mode: 'and', k: 1, clauses: [], rows: [R('a', 1, null), R('b', 1, null)] },
    { mode: 'atLeastK', k: 2, clauses: [], rows: [R('a', 1, null), R('b', 1, null), R('c', 1, null)] },
    { mode: 'and', k: 1, clauses: [], rows: [R('a', 1, null, true), R('b', 0, 1)] },
    { mode: 'and', k: 1, clauses: [], rows: [R('a', 1, 1)] },
    { mode: 'and', k: 0, clauses: [], rows: [] },
    // OR of single-condition combos (the old simple OR)
    { mode: 'or', k: 1, rows: [], clauses: [{ rows: [R('a', 2, null)] }, { rows: [R('b', 2, null)] }] },
    // OR of MULTI-condition combos: (A>1 & B>2) | (C>1)
    {
      mode: 'or', k: 1, rows: [],
      clauses: [{ rows: [R('a', 2, null), R('b', 3, null)] }, { rows: [R('c', 2, null)] }],
    },
    // three combos, one of them a range + a negation together
    {
      mode: 'or', k: 1, rows: [],
      clauses: [
        { rows: [R('a', 1, 2), R('b', 1, null, true)] },
        { rows: [R('c', 1, null)] },
        { rows: [R('a', 1, null), R('c', 1, null)] },
      ],
    },
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
  it('is the inverse of compileFlat for and/atLeastK', () => {
    const cases: FlatQuery[] = [
      { mode: 'and', k: 1, clauses: [], rows: [R('a', 1, null), R('b', 1, null, true)] },
      { mode: 'atLeastK', k: 2, clauses: [], rows: [R('a', 1, null), R('b', 1, null), R('c', 1, null)] },
      { mode: 'and', k: 1, clauses: [], rows: [R('a', 1, 1)] },
    ];
    for (const fq of cases) {
      const got = decompileFlat(compileFlat(fq));
      expect(got).toEqual(fq);
    }
  });

  it('is the inverse of compileFlat for OR of multi-condition combos', () => {
    const fq: FlatQuery = {
      mode: 'or', k: 1, rows: [],
      clauses: [{ rows: [R('a', 2, null), R('b', 3, null)] }, { rows: [R('c', 2, null)] }],
    };
    expect(decompileFlat(compileFlat(fq))).toEqual(fq);
  });

  it('refuses genuinely nested expressions rather than guessing', () => {
    expect(decompileFlat(and(or(atLeast('a', 1), atLeast('b', 1)), atLeast('c', 1)))).toBeNull();
    expect(decompileFlat(not(and(atLeast('a', 1), atLeast('b', 1))))).toBeNull();
    // an OR whose branch is itself an OR — one level deeper than this shape covers
    expect(decompileFlat(or(or(atLeast('a', 1), atLeast('b', 1)), atLeast('c', 1)))).toBeNull();
  });

  it('accepts a single bare atom or a single negated atom', () => {
    expect(decompileFlat(atLeast('a', 2))).toEqual({ mode: 'and', ...noClauses, k: 1, rows: [R('a', 2, null)] });
    expect(decompileFlat(not(atMost('a', 1)))).toEqual({ mode: 'and', ...noClauses, k: 1, rows: [R('a', 0, 1, true)] });
  });

  it('an atLeastK whose kids are themselves compound is refused, not flattened wrongly', () => {
    expect(decompileFlat(atLeastKOf(2, and(atLeast('a', 1), atLeast('b', 1)), atLeast('c', 1)))).toBeNull();
  });
});

describe('range rows survive a full round-trip through TEXT, not just the AST', () => {
  it('a range row printed to text and reparsed still decompiles flat', () => {
    const fq: FlatQuery = { mode: 'atLeastK', k: 2, clauses: [], rows: [
      R('a', 1, null),
      R('b', 1, 3), // the case that broke: prints as "b>=1 & b<=3"
    ] };
    const printed = printExpr(compileFlat(fq), nameOf);
    const reparsed = parseQuery(printed, resolve);
    expect(decompileFlat(reparsed)).toEqual(fq);
  });

  it('a range row alone (not inside atLeastK/OR) also survives', () => {
    const fq: FlatQuery = { mode: 'and', k: 1, clauses: [], rows: [R('a', 2, 3)] };
    expect(decompileFlat(parseQuery(printExpr(compileFlat(fq), nameOf), resolve))).toEqual(fq);
  });

  it('a range condition survives inside an OR combo alongside another condition', () => {
    const fq: FlatQuery = {
      mode: 'or', k: 1, rows: [],
      clauses: [{ rows: [R('a', 1, 3), R('b', 1, null)] }, { rows: [R('c', 1, null)] }],
    };
    const printed = printExpr(compileFlat(fq), nameOf);
    expect(decompileFlat(parseQuery(printed, resolve))).toEqual(fq);
  });
});
