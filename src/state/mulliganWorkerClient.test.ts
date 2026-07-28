import { describe, it, expect } from 'vitest';
import { getMulliganWorker } from './mulliganWorkerClient';
import { parseQuery } from '../math/parse';
import { normalize } from '../math/normalize';
import type { MulliganBatchSuccess, MulliganSingleSuccess } from '../workers/mulliganProtocol';

const resolve = (n: string) => ({ land: 'g0', ramp: 'g1' }[n.toLowerCase()] ?? null);

/** In this jsdom environment getMulliganWorker() always returns the sync
 * fallback (confirmed elsewhere: jsdom has no Worker at all) -- this tests
 * that fallback's OWN request/response handling directly, which is exactly
 * the logic real users' browsers would also exercise via the real worker
 * (mulliganWorker.ts shares the same dispatch structure). */
describe('mulliganWorkerClient (sync fallback -- protocol correctness for both request kinds)', () => {
  it('handles a "single" request correctly', async () => {
    const worker = getMulliganWorker();
    const ast = parseQuery('land>=1', resolve);
    const sizes = { g0: 10 };
    const dnf = normalize(ast, sizes);

    const result = await new Promise<MulliganSingleSuccess>((resolve) => {
      const onMsg = (e: MessageEvent) => {
        worker.removeEventListener('message', onMsg);
        resolve(e.data);
      };
      worker.addEventListener('message', onMsg);
      worker.postMessage({ id: 1, kind: 'single', dnf, sizes, deckSize: 40, handSize: 7, extraDrawsForT: 3, maxMulligans: 1 });
    });

    expect(result.ok).toBe(true);
    expect(result.kind).toBe('single');
    expect(result.strategy.bestP).toBeGreaterThanOrEqual(0);
    expect(result.strategy.bestP).toBeLessThanOrEqual(1);
  });

  it('handles a "batch" request correctly -- one entry per row, in the same order as the request', async () => {
    const worker = getMulliganWorker();
    const ast = parseQuery('land>=1', resolve);
    const entries = [4, 6, 8].map((count) => {
      const sizes = { g0: count };
      return { dnf: normalize(ast, sizes), sizes };
    });

    const result = await new Promise<MulliganBatchSuccess>((resolve) => {
      const onMsg = (e: MessageEvent) => {
        worker.removeEventListener('message', onMsg);
        resolve(e.data);
      };
      worker.addEventListener('message', onMsg);
      worker.postMessage({ id: 2, kind: 'batch', entries, deckSize: 40, handSize: 7, maxMulligans: 1 });
    });

    expect(result.ok).toBe(true);
    expect(result.kind).toBe('batch');
    expect(result.curves.length).toBe(3);
    // higher land count -> higher bestCurve values at the same index (monotone query)
    const at3 = result.curves.map((c) => c?.bestCurve[3] ?? -1);
    expect(at3[0]!).toBeLessThanOrEqual(at3[1]!);
    expect(at3[1]!).toBeLessThanOrEqual(at3[2]!);
  });

  it('one throwing row in a batch does not fail the whole batch -- that row is null, others still compute correctly', async () => {
    const worker = getMulliganWorker();
    const goodAst = parseQuery('land>=1', resolve);
    const goodSizes = { g0: 10 };
    const badAst = parseQuery('a>=1 & b>=1 & c>=1 & d>=1 & e>=1', (n) =>
      ({ a: 'g0', b: 'g1', c: 'g2', d: 'g3', e: 'g4' }[n.toLowerCase()] ?? null));
    const badSizes = { g0: 2, g1: 2, g2: 2, g3: 2, g4: 2 };
    // Confirmed directly before writing this test: 5 groups unconditionally
    // throws (checkSizeCap's groups>4 branch, independent of size values),
    // unlike varying a single group's count -- which does NOT throw for any
    // reasonable size, so it's not a usable "make one row infeasible" lever.
    const entries = [
      { dnf: normalize(goodAst, goodSizes), sizes: goodSizes },
      { dnf: normalize(badAst, badSizes), sizes: badSizes },
    ];

    const result = await new Promise<MulliganBatchSuccess>((resolve) => {
      const onMsg = (e: MessageEvent) => {
        worker.removeEventListener('message', onMsg);
        resolve(e.data);
      };
      worker.addEventListener('message', onMsg);
      worker.postMessage({ id: 3, kind: 'batch', entries, deckSize: 40, handSize: 7, maxMulligans: 1 });
    });

    expect(result.ok).toBe(true);
    expect(result.curves.length).toBe(2);
    expect(result.curves[0]).not.toBeNull(); // the good row still computed
    expect(result.curves[1]).toBeNull(); // the bad row is null, not a thrown batch failure
  });
});
