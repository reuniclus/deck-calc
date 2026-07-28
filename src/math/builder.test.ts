import { describe, it, expect } from 'vitest';
import { compileFlat, decompileFlat, type Clause, type FlatQuery } from './builder';
import { printExpr } from './print';
import { parseQuery } from './parse';
import { normalize } from './normalize';
import { and, or, not, atLeast, atLeastKOf, atMost, TRUE, type Sizes, type Expr } from './expr';

const SIZES: Sizes = { a: 3, b: 3, c: 2 };
const nameOf = (g: string) => g.toUpperCase();
const resolve = (n: string): string | null => (n.toLowerCase() in SIZES ? n.toLowerCase() : null);

const R = (g: string, lo: number, hi: number | null) => ({ g, lo, hi });
const C = (rows: ReturnType<typeof R>[]): Clause => ({ rows });
const fq = (...clauses: Clause[]): FlatQuery => ({ clauses });

describe('compileFlat -> printExpr -> parseQuery round-trips', () => {
  const cases: FlatQuery[] = [
    fq(C([R('a', 1, null), R('b', 1, null)])),                       // one combo (AND)
    fq(C([R('a', 0, 0), R('b', 0, 1)])),                              // "not a>=1" written directly as a<=0
    fq(C([R('a', 1, 1)])),                                           // single condition
    fq(C([R('a', 2, null)]), C([R('b', 2, null)])),                  // OR of single conditions
    fq(C([R('a', 2, null), R('b', 3, null)]), C([R('c', 2, null)])), // OR of multi-condition combos
    fq(                                                                // three combos, mixed shapes
      C([R('a', 1, 2), R('b', 0, 0)]),
      C([R('c', 1, null)]),
      C([R('a', 1, null), R('c', 1, null)]),
    ),
    { clauses: [] },                                                 // nothing at all -> unconstrained
  ];
  for (const q of cases) {
    it(JSON.stringify(q), () => {
      const expr = compileFlat(q);
      const text = printExpr(expr, nameOf);
      const back = parseQuery(text, resolve);
      expect(normalize(back, SIZES)).toEqual(normalize(expr, SIZES));
    });
  }
});

describe('decompileFlat', () => {
  it('is the inverse of compileFlat for AND and OR-of-combos shapes', () => {
    const cases: FlatQuery[] = [
      fq(C([R('a', 1, null), R('b', 0, 0)])),
      fq(C([R('a', 1, 1)])),
      fq(C([R('a', 2, null), R('b', 3, null)]), C([R('c', 2, null)])),
    ];
    for (const q of cases) expect(decompileFlat(compileFlat(q))).toEqual(q);
  });

  it('refuses genuinely nested expressions rather than guessing', () => {
    expect(decompileFlat(and(or(atLeast('a', 1), atLeast('b', 1)), atLeast('c', 1)))).toBeNull();
    expect(decompileFlat(not(and(atLeast('a', 1), atLeast('b', 1))))).toBeNull();
    expect(decompileFlat(or(or(atLeast('a', 1), atLeast('b', 1)), atLeast('c', 1)))).toBeNull();
  });

  it('accepts a single bare atom as one combo', () => {
    expect(decompileFlat(atLeast('a', 2))).toEqual(fq(C([R('a', 2, null)])));
  });

  it('there is no "not" toggle in the row builder -- NOT(>=) and NOT(<=) are rewritten to the direct equivalent comparator, not carried as a separate concept', () => {
    // NOT(a>=2) = a<=1 -- exactly the same condition, not merely equivalent.
    expect(decompileFlat(not(atLeast('a', 2)))).toEqual(fq(C([R('a', 0, 1)])));
    // NOT(a<=1) = a>=2.
    expect(decompileFlat(not(atMost('a', 1)))).toEqual(fq(C([R('a', 2, null)])));
    // The degenerate "not >= 0" is impossible (every count is already >=0)
    // -- not a sensible row, correctly refused rather than misrepresented.
    expect(decompileFlat(not(atLeast('a', 0)))).toBeNull();
  });

  it('NOT of a genuine range or exact count is NOT reducible to one row -- refused (falls back to text), not silently misrepresented', () => {
    // NOT(2<=a<=3) = a<1 OR a>3 -- a disjoint union, not a single row's lo/hi.
    const range: Expr = { t: 'atom', g: 'a', lo: 2, hi: 3 };
    expect(decompileFlat(not(range))).toBeNull();
    // NOT(a==1), i.e. a!=1 -- same issue (eq is lo===hi, a special case of range).
    const eq: Expr = { t: 'atom', g: 'a', lo: 1, hi: 1 };
    expect(decompileFlat(not(eq))).toBeNull();
    // But confirm the QUERY LANGUAGE itself still accepts and evaluates this
    // correctly -- only the ROW BUILDER's construction is refused, nothing
    // about what's expressible is actually lost.
    expect(() => normalize(not(range), SIZES)).not.toThrow();
  });

  it('atLeastK has no builder representation anymore — refused, not silently reshaped', () => {
    expect(decompileFlat(atLeastKOf(2, atLeast('a', 1), atLeast('b', 1), atLeast('c', 1)))).toBeNull();
    // ...even nested inside an OR alongside an otherwise-flat combo:
    expect(decompileFlat(or(atLeastKOf(2, atLeast('a', 1), atLeast('b', 1)), atLeast('c', 1)))).toBeNull();
  });

  it('an empty query (no conditions) compiles to TRUE and back to zero combos', () => {
    expect(compileFlat({ clauses: [] })).toEqual(TRUE);
    expect(compileFlat({ clauses: [C([])] })).toEqual(TRUE); // an empty combo contributes nothing
  });
});

describe('range rows survive a full round-trip through TEXT, not just the AST', () => {
  it('a range row alone (single combo) survives', () => {
    const q = fq(C([R('a', 2, 3)]));
    expect(decompileFlat(parseQuery(printExpr(compileFlat(q), nameOf), resolve))).toEqual(q);
  });

  it('a range row alongside another condition in the same combo survives', () => {
    const q = fq(C([R('a', 1, null), R('b', 1, 3)]));
    expect(decompileFlat(parseQuery(printExpr(compileFlat(q), nameOf), resolve))).toEqual(q);
  });

  it('a range condition survives inside one OR branch alongside another condition', () => {
    const q = fq(C([R('a', 1, 3), R('b', 1, null)]), C([R('c', 1, null)]));
    const printed = printExpr(compileFlat(q), nameOf);
    expect(decompileFlat(parseQuery(printed, resolve))).toEqual(q);
  });
});

describe('printExpr still handles atLeastK correctly, even though the builder cannot author one', () => {
  it('expands to an equivalent, reparseable OR-of-ANDs (no "any k of" keyword exists anymore)', () => {
    const e = atLeastKOf(2, atLeast('a', 1), atLeast('b', 1), atLeast('c', 1));
    const text = printExpr(e, nameOf);
    expect(text.toLowerCase()).not.toContain('any');
    expect(text.toLowerCase()).not.toContain('of (');
    const reparsed = parseQuery(text, resolve);
    expect(normalize(reparsed, SIZES)).toEqual(normalize(e, SIZES));
  });
});
