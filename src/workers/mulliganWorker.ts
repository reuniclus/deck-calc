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
import type { MulliganComputeRequest, MulliganComputeResponse } from './mulliganProtocol';

self.onmessage = (e: MessageEvent<MulliganComputeRequest>) => {
  const { id, dnf, sizes, deckSize, handSize, extraDrawsForT, maxMulligans } = e.data;
  try {
    const strategy = optimalMulliganStrategy(dnf, sizes, deckSize, handSize, extraDrawsForT, maxMulligans);
    const curves = optimalMulliganCurve(dnf, sizes, deckSize, handSize, maxMulligans);
    const response: MulliganComputeResponse = { id, ok: true, strategy, curves };
    (self as unknown as Worker).postMessage(response);
  } catch (err) {
    const message = err instanceof MulliganTooLargeError ? err.message : (err instanceof Error ? err.message : String(err));
    const response: MulliganComputeResponse = { id, ok: false, error: message };
    (self as unknown as Worker).postMessage(response);
  }
};
