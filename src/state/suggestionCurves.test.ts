import { describe, it, expect } from 'vitest';
import { curvesForVectors } from './suggestionCurves';
import { suggestVectors } from '../math/suggestSearch';
import { parseQuery } from '../math/parse';
import { normalize } from '../math/normalize';

const resolve = (n: string) => ({
  blinketb: 'g0', blinkspell: 'g1', land: 'g0', ramp: 'g1',
}[n.toLowerCase().replace(/\s/g, '')] ?? null);

describe('curvesForVectors', () => {
  it('dedupes symmetric swapped vectors into ONE curve (real math bug caught earlier this project)', () => {
    const ast = parseQuery('"Blink ETB">=1 & "Blink Spell">=1', resolve);
    const sizes = { g0: 4, g1: 3 };
    const dnf = normalize(ast, sizes);
    const { vectors } = suggestVectors(ast, dnf, 40, 10, 0.9);
    const out = curvesForVectors(ast, vectors, 40, sizes);
    // known from earlier this session: minimalVectors returns (8,11)/(9,10)/(10,9)/(11,8);
    // by symmetry (8,11)~(11,8) and (9,10)~(10,9) are curve-identical -> 2 distinct curves.
    expect(out.length).toBe(2);
    const totalVectors = out.reduce((s, o) => s + o.vectors.length, 0);
    expect(totalVectors).toBe(4);
    expect(out.every((o) => o.vectors.length === 2)).toBe(true);
  });

  it('every returned curve actually reaches target at n (minimality holds, sanity-checked against the search itself)', () => {
    const ast = parseQuery('"Blink ETB">=1 & "Blink Spell">=1', resolve);
    const sizes = { g0: 4, g1: 3 };
    const dnf = normalize(ast, sizes);
    const { vectors } = suggestVectors(ast, dnf, 40, 10, 0.9);
    const out = curvesForVectors(ast, vectors, 40, sizes);
    for (const { curve } of out) {
      expect(curve[10]!).toBeGreaterThanOrEqual(0.9 - 1e-9);
    }
  });

  it('returns an empty list for an empty vector list, without throwing', () => {
    const ast = parseQuery('"Blink ETB">=1', resolve);
    expect(curvesForVectors(ast, [], 40, { g0: 4, g1: 3 })).toEqual([]);
  });

  it('THE ACTUAL REGRESSION: an OR/negated query (mana flood avoidance) now produces real phantom curves, not an empty list', () => {
    const ast = parseQuery('!land>=4 | (!land>=3 & !ramp>=1)', resolve);
    const sizes = { g0: 38, g1: 6 };
    const dnf = normalize(ast, sizes);
    expect(dnf.monotone).toBe(false); // confirms this genuinely exercises the general path
    const { vectors } = suggestVectors(ast, dnf, 99, 13, 0.9);
    const out = curvesForVectors(ast, vectors, 99, sizes);
    expect(out.length).toBeGreaterThan(0);
    for (const { curve } of out) expect(curve[13]!).toBeGreaterThanOrEqual(0.9 - 1e-9);
  });
});
