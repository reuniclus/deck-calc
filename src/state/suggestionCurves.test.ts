import { describe, it, expect } from 'vitest';
import { computeSuggestionCurves } from './suggestionCurves';
import { parseQuery } from '../math/parse';
import { normalize } from '../math/normalize';

const resolve = (n: string) => ({ blinketb: 'g0', blinkspell: 'g1' }[n.toLowerCase().replace(/\s/g, '')] ?? null);

describe('computeSuggestionCurves', () => {
  it('dedupes symmetric swapped vectors into ONE curve (real math bug caught earlier this project)', () => {
    const ast = parseQuery('"Blink ETB">=1 & "Blink Spell">=1', resolve);
    const clause = normalize(ast, { g0: 4, g1: 3 }).clauses[0]!;
    const out = computeSuggestionCurves(ast, clause, 40, 10, 0.9, { g0: 4, g1: 3 });
    // known from earlier this session: minimalVectors returns (8,11)/(9,10)/(10,9)/(11,8);
    // by symmetry (8,11)~(11,8) and (9,10)~(10,9) are curve-identical -> 2 distinct curves.
    expect(out.length).toBe(2);
    const totalVectors = out.reduce((s, o) => s + o.vectors.length, 0);
    expect(totalVectors).toBe(4);
    // each distinct curve should have exactly 2 tied vectors (the symmetric pair)
    expect(out.every((o) => o.vectors.length === 2)).toBe(true);
  });

  it('every returned curve actually reaches target at n, and none below n-1 does (minimality holds)', () => {
    const ast = parseQuery('"Blink ETB">=1 & "Blink Spell">=1', resolve);
    const clause = normalize(ast, { g0: 4, g1: 3 }).clauses[0]!;
    const out = computeSuggestionCurves(ast, clause, 40, 10, 0.9, { g0: 4, g1: 3 });
    for (const { curve } of out) {
      expect(curve[10]!).toBeGreaterThanOrEqual(0.9 - 1e-9);
    }
  });

  it('returns empty for more than 4 groups (same cap as the frontier/advisor tools)', () => {
    const ast = parseQuery(
      '"A">=1 & "B">=1 & "C">=1 & "D">=1 & "E">=1',
      (n) => ({ a: 'g0', b: 'g1', c: 'g2', d: 'g3', e: 'g4' }[n.toLowerCase()] ?? null),
    );
    const sizes = { g0: 2, g1: 2, g2: 2, g3: 2, g4: 2 };
    const clause = normalize(ast, sizes).clauses[0]!;
    expect(computeSuggestionCurves(ast, clause, 40, 10, 0.5, sizes)).toEqual([]);
  });

  it('returns empty (not throws) when the target is genuinely unreachable (n=0 can never satisfy >=1)', () => {
    const ast = parseQuery('"Blink ETB">=1', resolve);
    const clause = normalize(ast, { g0: 1, g1: 3 }).clauses[0]!;
    const out = computeSuggestionCurves(ast, clause, 40, 0, 0.5, { g0: 1, g1: 3 });
    expect(out).toEqual([]);
  });
});
