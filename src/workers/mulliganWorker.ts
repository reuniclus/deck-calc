/**
 * Runs the exact mulligan computation (src/math/mulligan.ts) off the main
 * thread. This file is deliberately thin -- it imports the SAME
 * already-tested pure functions used elsewhere, no new math lives here.
 * The only new logic is the message dispatch, tested separately via
 * useWorkerRequest.test.ts using a fake worker-like object (jsdom has no
 * real Worker at all -- confirmed directly, same class of gap as
 * IntersectionObserver -- so this file's OWN logic can't be exercised in
 * jsdom, but it's intentionally small enough that there's little to get
 * wrong here that the math tests don't already cover).
 */
import { optimalMulliganStrategy, optimalMulliganCurve, MulliganTooLargeError } from '../math/mulligan';
import type { MulliganRequest, MulliganResponse } from './mulliganProtocol';

function errMessage(err: unknown): string {
  return err instanceof MulliganTooLargeError ? err.message : (err instanceof Error ? err.message : String(err));
}

self.onmessage = (e: MessageEvent<MulliganRequest>) => {
  const req = e.data;
  let response: MulliganResponse;

  if (req.kind === 'single') {
    try {
      const strategy = optimalMulliganStrategy(
        req.dnf, req.sizes, req.deckSize, req.handSize, req.extraDrawsForT, req.maxMulligans);
      const curves = optimalMulliganCurve(req.dnf, req.sizes, req.deckSize, req.handSize, req.maxMulligans);
      response = { id: req.id, kind: 'single', ok: true, strategy, curves };
    } catch (err) {
      response = { id: req.id, kind: 'single', ok: false, error: errMessage(err) };
    }
  } else {
    try {
      const curves = req.entries.map(({ dnf, sizes }) => {
        try {
          return optimalMulliganCurve(dnf, sizes, req.deckSize, req.handSize, req.maxMulligans);
        } catch {
          return null; // one infeasible row shouldn't fail the whole batch
        }
      });
      response = { id: req.id, kind: 'batch', ok: true, curves };
    } catch (err) {
      response = { id: req.id, kind: 'batch', ok: false, error: errMessage(err) };
    }
  }
  (self as unknown as Worker).postMessage(response);
};
