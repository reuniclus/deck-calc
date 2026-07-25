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
/** A clause with no explicit k defaults to "all of its rows" (AND), matching the app's default combo. */
const C = (rows: ReturnType<typeof R>[], k?: number): Clause => ({ rows, k: k ?? rows.length });
const fq = (...clauses: Clause[]): FlatQuery => ({ clauses });

describe('compileFlat -> printExpr -> parseQuery round-trips', () => {
  const cases: FlatQuery[] = [
    fq(C([R('a', 1, null), R('b', 1, null)])),                        // one combo, k=all (AND)
    fq(C([R('a', 1, null), R('b', 1, null), R('c', 1, null)], 2)),     // one combo, "any 2 of"
    fq(C([R('a', 1, null, true), R('b', 0, 1)])),                      // negation + range, k=all
    fq(C([R('a', 1, 1)])),                                             // single condition
    fq(C([R('a', 2, null)]), C([R('b', 2, null)])),                    // OR of single conditions ("any of these")
    fq(C([R('a', 2, null), R('b', 3, null)]), C([R('c', 2, null)])),   // OR of multi-condition combos
    fq(                                                                  // OR where one combo has a partial threshold
      C([R('a', 1, null), R('b', 1, null), R('c', 1, null)], 2),
      C([R('c', 1, null)]),
    ),
    { clauses: [] },                                                   // nothing at all -> unconstrained
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
  it('is the inverse of compileFlat across AND / partial-threshold / OR shapes', () => {
    const cases: FlatQuery[] = [
      fq(C([R('a', 1, null), R('b', 1, null, true)])),
      fq(C([R('a', 1, null), R('b', 1, null), R('c', 1, null)], 2)),
      fq(C([R('a', 1, 1)])),
      fq(C([R('a', 2, null), R('b', 3, null)]), C([R('c', 2, null)])),
    ];
    for (const q of cases) expect(decompileFlat(compileFlat(q))).toEqual(q);
  });

  it('a fresh single combo defaults k to "all" (AND), not any special-cased default', () => {
    const q = decompileFlat(and(atLeast('a', 1), atLeast('b', 1)));
    expect(q).toEqual(fq(C([R('a', 1, null), R('b', 1, null)])));
    expect(q!.clauses[0]!.k).toBe(q!.clauses[0]!.rows.length); // "all" IS k===rows.length, no flag needed
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

  it('an atLeastK whose kids are themselves compound is refused, not flattened wrongly', () => {
    expect(decompileFlat(atLeastKOf(2, and(atLeast('a', 1), atLeast('b', 1)), atLeast('c', 1)))).toBeNull();
  });

  it('an empty query (no conditions) compiles to TRUE and back to zero combos', () => {
    expect(compileFlat({ clauses: [] })).toEqual(TRUE);
    expect(compileFlat({ clauses: [C([])] })).toEqual(TRUE); // an empty combo contributes nothing
  });
});

describe('range rows survive a full round-trip through TEXT, not just the AST', () => {
  it('a range row inside a partial-threshold combo survives', () => {
    const q = fq(C([R('a', 1, null), R('b', 1, 3)], 1)); // the case that broke: "b>=1 & b<=3" as one atLeastK kid
    const reparsed = parseQuery(printExpr(compileFlat(q), nameOf), resolve);
    expect(decompileFlat(reparsed)).toEqual(q);
  });

  it('a range row alone (single combo, k=all) also survives', () => {
    const q = fq(C([R('a', 2, 3)]));
    expect(decompileFlat(parseQuery(printExpr(compileFlat(q), nameOf), resolve))).toEqual(q);
  });

  it('a range condition survives inside one OR branch alongside another condition', () => {
    const q = fq(C([R('a', 1, 3), R('b', 1, null)]), C([R('c', 1, null)]));
    const printed = printExpr(compileFlat(q), nameOf);
    expect(decompileFlat(parseQuery(printed, resolve))).toEqual(q);
  });
});
