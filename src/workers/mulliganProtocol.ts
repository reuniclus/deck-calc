/**
 * Message protocol between the main thread and mulliganWorker.ts. Kept as
 * plain, structurally-typed request/response shapes (not classes) since
 * they cross a postMessage boundary -- anything sent must survive
 * structured-clone as-is.
 */
import type { Dnf, Sizes } from '../math/expr';

export interface MulliganComputeRequest {
  id: number;
  dnf: Dnf;
  sizes: Sizes;
  deckSize: number;
  handSize: number;
  extraDrawsForT: number;
  maxMulligans: number;
}

export interface MulliganComputeSuccess {
  id: number;
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

export interface MulliganComputeFailure {
  id: number;
  ok: false;
  error: string;
}

export type MulliganComputeResponse = MulliganComputeSuccess | MulliganComputeFailure;
