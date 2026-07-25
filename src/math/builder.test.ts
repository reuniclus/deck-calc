import { describe, it, expect } from 'vitest';
import { compileFlat, decompileFlat, type Clause, type FlatQuery } from './builder';
import { printExpr } from './print';
import { parseQuery } from './parse';
import { normalize } from './normalize';
import { and, or, not, atLeast, atLeastKOf, atMost, TRUE, type Sizes } from './expr';

const SIZES: Sizes = { a: 3, b: 3, c: 2 };
const nameOf = (g: string) => g.toUpperCase();
const resolve = (n: string): string | null => (n.toLowerCase() in SIZES ? n.toLowerCase() : null);

const R = (g: string, lo: number, hi: number | null, neg = false) => ({ g, neg, lo, hi });
const C = (rows: ReturnType<typeof R>[]): Clause => ({ rows });
const fq = (...clauses: Clause[]): FlatQuery => ({ clauses });

describe('compileFlat -> printExpr -> parseQuery round-trips', () => {
  const cases: FlatQuery[] = [
    fq(C([R('a', 1, null), R('b', 1, null)])),                       // one combo (AND)
    fq(C([R('a', 1, null, true), R('b', 0, 1)])),                    // negation + range
    fq(C([R('a', 1, 1)])),                                           // single condition
    fq(C([R('a', 2, null)]), C([R('b', 2, null)])),                  // OR of single conditions
    fq(C([R('a', 2, null), R('b', 3, null)]), C([R('c', 2, null)])), // OR of multi-condition combos
    fq(                                                                // three combos, mixed shapes
      C([R('a', 1, 2), R('b', 1, null, true)]),
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
      fq(C([R('a', 1, null), R('b', 1, null, true)])),
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

  it('accepts a single bare atom or a single negated atom as one combo', () => {
    expect(decompileFlat(atLeast('a', 2))).toEqual(fq(C([R('a', 2, null)])));
    expect(decompileFlat(not(atMost('a', 1)))).toEqual(fq(C([R('a', 0, 1, true)])));
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
