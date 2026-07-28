/**
 * Owns getting a mulligan-computing WorkerLike, real or fallback.
 *
 * Real Worker: a genuine separate thread, so a multi-second computation
 * (confirmed: ~0.5s for 1 mulligan, several seconds for 2 -- see chat
 * history) never freezes the page. Constructed lazily, once, since
 * spinning up a worker has real overhead of its own.
 *
 * Fallback: jsdom has no Worker at all (confirmed directly, same class of
 * gap as IntersectionObserver), and in principle SOME environment could
 * lack Worker support too. This computes SYNCHRONOUSLY on the main
 * thread -- the exact blocking behavior being fixed for real users, kept
 * only so tests and any Worker-less environment still get a CORRECT
 * answer instead of nothing. Implements the SAME WorkerLike interface so
 * useMulliganStrategy.tsx has exactly one code path regardless of which
 * one it got.
 */
import { optimalMulliganStrategy, optimalMulliganCurve, MulliganTooLargeError } from '../math/mulligan';
import type { WorkerLike } from './useWorkerRequest';
import type { MulliganRequest, MulliganResponse } from '../workers/mulliganProtocol';

function errMessage(err: unknown): string {
  return err instanceof MulliganTooLargeError ? err.message : (err instanceof Error ? err.message : String(err));
}

class SyncFallbackMulliganWorker implements WorkerLike {
  private listeners: Array<(e: MessageEvent) => void> = [];

  addEventListener(_type: 'message', listener: (e: MessageEvent) => void): void {
    this.listeners.push(listener);
  }
  removeEventListener(_type: 'message', listener: (e: MessageEvent) => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }
  postMessage(message: unknown): void {
    const req = message as MulliganRequest;
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
            return null;
          }
        });
        response = { id: req.id, kind: 'batch', ok: true, curves };
      } catch (err) {
        response = { id: req.id, kind: 'batch', ok: false, error: errMessage(err) };
      }
    }
    // Deferred, not synchronous-inline: keeps this on the same footing as a
    // real worker's message timing (always at least one microtask away),
    // so effect ordering in useWorkerRequest behaves identically either way.
    queueMicrotask(() => {
      const event = { data: response } as MessageEvent;
      for (const l of this.listeners) l(event);
    });
  }
}

let cached: WorkerLike | null | undefined;
let cachedFallback: SyncFallbackMulliganWorker | null = null;

export function getMulliganWorker(): WorkerLike {
  if (cached === undefined) {
    try {
      cached = typeof Worker !== 'undefined'
        ? new Worker(new URL('../workers/mulliganWorker.ts', import.meta.url), { type: 'module' })
        : null;
    } catch {
      cached = null;
    }
  }
  if (cached) return cached;
  if (!cachedFallback) cachedFallback = new SyncFallbackMulliganWorker();
  return cachedFallback;
}
