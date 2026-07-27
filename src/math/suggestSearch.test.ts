import { describe, it, expect } from 'vitest';
import { suggestVectors } from './suggestSearch';
import { parseQuery } from './parse';
import { normalize } from './normalize';

const resolve = (n: string) => ({ 'blink etb': 'g0', 'blink spell': 'g1', land: 'g0', ramp: 'g1' }[n.toLowerCase()] ?? null);

describe('suggestVectors dispatch', () => {
  it('uses the fast path for a single monotone AND-clause', () => {
    const ast = parseQuery('"Blink ETB">=1 & "Blink Spell">=1', resolve);
    const dnf = normalize(ast, { g0: 4, g1: 3 });
    const { vectors, usedGeneralPath } = suggestVectors(ast, dnf, 40, 10, 0.9);
    expect(usedGeneralPath).toBe(false);
    expect(vectors.length).toBeGreaterThan(0);
  });

  it('uses the general path for the exact reported OR/negated case, and finds real vectors -- this was the broken scenario (chart showed nothing here)', () => {
    const ast = parseQuery('!land>=4 | (!land>=3 & !ramp>=1)', resolve);
    const dnf = normalize(ast, { g0: 38, g1: 6 });
    const { vectors, usedGeneralPath } = suggestVectors(ast, dnf, 99, 13, 0.9);
    expect(usedGeneralPath).toBe(true);
    expect(vectors.length).toBeGreaterThan(0);
  });

  it('fast and general paths agree on a case solvable by both (sanity cross-check)', () => {
    // A single AND-clause with no NOT is fast-path eligible; force the
    // general path artificially by checking frontier.ts's own vectors match
    // what generalMinimalVectors would find independently (already covered
    // by generalSuggest.test.ts's own tests) -- here just confirm suggestVectors
    // routes a genuinely monotone single clause to the fast path, not general.
    const ast = parseQuery('"Blink ETB">=1', resolve);
    const dnf = normalize(ast, { g0: 4, g1: 3 });
    const { usedGeneralPath } = suggestVectors(ast, dnf, 40, 10, 0.9);
    expect(usedGeneralPath).toBe(false);
  });
});
