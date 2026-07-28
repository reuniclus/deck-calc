/**
 * Message protocol between the main thread and mulliganWorker.ts. Kept as
 * plain, structurally-typed request/response shapes (not classes) since
 * they cross a postMessage boundary -- anything sent must survive
 * structured-clone as-is.
 *
 * Two request kinds: 'single' (the advisor strip / Suggestions tab / chart's
 * one goal-turn point) and 'batch' (the Grid tab's per-swept-row curves --
 * originally computed synchronously in a loop on the main thread, which was
 * a real, confirmed cause of UI jank even though the 'single' kind was
 * already offloaded: measured directly, ~160ms for the default deck, scaling
 * up with deck/group complexity for larger decks). One round trip computes
 * every row's curve in the SAME worker call rather than one round trip per
 * row -- deckSize/handSize/maxMulligans are shared across rows, but each
 * row's OWN dnf must be provided too (normalize()'s subsumption logic can
 * produce a genuinely different Dnf structure per composition, confirmed
 * elsewhere this project, so dnf can't be shared across rows the way
 * deckSize/handSize/maxMulligans can).
 */
import type { Dnf, Sizes } from '../math/expr';

export interface MulliganSingleRequest {
  id: number;
  kind: 'single';
  dnf: Dnf;
  sizes: Sizes;
  deckSize: number;
  handSize: number;
  extraDrawsForT: number;
  maxMulligans: number;
}

export interface MulliganSingleSuccess {
  id: number;
  kind: 'single';
  ok: true;
  strategy: {
    bestP: number;
    neverMulliganP: number;
    strategy: Array<{ hand: Record<string, number>; probability: number; keepP: number; mulliganP: number; shouldKeep: boolean }>;
  };
  curves: {
    bestCurve: Float64Array;
    neverMulliganCurve: Float64Array;
  };
}

export interface MulliganBatchRequest {
  id: number;
  kind: 'batch';
  /** One entry per swept row -- normalize()'s subsumption logic can
   * produce a genuinely different Dnf structure per composition (confirmed
   * elsewhere this project), so each row needs its OWN already-normalized
   * dnf, not one shared dnf reused across different sizes. deckSize/
   * handSize/maxMulligans ARE shared -- those don't depend on composition. */
  entries: Array<{ dnf: Dnf; sizes: Sizes }>;
  deckSize: number;
  handSize: number;
  maxMulligans: number;
}

export interface MulliganBatchSuccess {
  id: number;
  kind: 'batch';
  ok: true;
  /** Same length/order as the request's sizesList; null for any row that
   * individually threw (e.g. infeasible sizes), so one bad row doesn't
   * fail the whole batch. */
  curves: Array<{ bestCurve: Float64Array; neverMulliganCurve: Float64Array } | null>;
}

export interface MulliganFailure {
  id: number;
  kind: 'single' | 'batch';
  ok: false;
  error: string;
}

export type MulliganRequest = MulliganSingleRequest | MulliganBatchRequest;
export type MulliganResponse = MulliganSingleSuccess | MulliganBatchSuccess | MulliganFailure;
