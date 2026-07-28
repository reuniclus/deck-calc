/**
 * Shares the optimal-mulligan-strategy computation, now run through a Web
 * Worker (or a same-shape synchronous fallback -- see mulliganWorkerClient.ts)
 * instead of blocking the main thread directly. Measured directly before
 * this change: ~0.5s for 1 mulligan, several seconds for 2 -- genuinely
 * long enough to freeze the page, not a minor jank. Wrapping a synchronous
 * call in a Promise does NOT fix this (JS is single-threaded; the executor
 * still runs on the same thread) -- only a real separate thread does, which
 * is what a Worker actually is.
 */
import { useMemo, createContext, useContext, useRef, type ReactNode } from 'react';
import { useAppState } from './AppState';
import { useQueryModelCtx } from './useQueryModel';
import { cardsSeenByTurn } from '../model/turns';
import { useWorkerRequest, type WorkerLike } from './useWorkerRequest';
import { getMulliganWorker } from './mulliganWorkerClient';
import type { MulliganSingleRequest, MulliganSingleSuccess, MulliganFailure } from '../workers/mulliganProtocol';
import type { MulliganResult, MulliganCurveResult } from '../math/mulligan';
import type { Curve } from '../math/boxdp';

export interface MulliganStrategyState {
  /** null when mulligans=0, the query is invalid, or a result hasn't
   * arrived yet. Deliberately kept from a PREVIOUS response while `loading`
   * is true (see useWorkerRequest's own doc comment) -- never blanked out
   * just because a new computation started. */
  result: MulliganResult | null;
  curves: MulliganCurveResult | null;
  tooLarge: string | null;
  /** True while a request is in flight (real Worker: genuinely non-
   * blocking; fallback: still resolves via a microtask, so this is
   * momentarily true either way). Show a "computing..." indicator, but
   * keep showing whatever `result`/`curves` already have. */
  loading: boolean;
}

const MulliganCtx = createContext<MulliganStrategyState | null>(null);

interface WorkerData { strategy: MulliganResult; curves: { bestCurve: Curve; neverMulliganCurve: Curve } }

export function MulliganStrategyProvider({ children }: { children: ReactNode }) {
  const { deckSize, turnCfg, target, adviseTurn } = useAppState();
  const { dnf, result: queryResult, sizes } = useQueryModelCtx();

  const workerRef = useRef<WorkerLike | null>(null);
  if (!workerRef.current) workerRef.current = getMulliganWorker();

  const request = useMemo<Omit<MulliganSingleRequest, 'id'> | null>(() => {
    if (turnCfg.mulligans <= 0 || !dnf || !queryResult) return null;
    const handSize = turnCfg.openingHand;
    const totalSeen = Math.min(deckSize, cardsSeenByTurn(adviseTurn, turnCfg));
    const extraDrawsForT = Math.max(0, totalSeen - handSize);
    return { kind: 'single', dnf, sizes, deckSize, handSize, extraDrawsForT, maxMulligans: turnCfg.mulligans };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dnf, queryResult, sizes, deckSize, turnCfg, adviseTurn, target]);

  const { data, loading, error } = useWorkerRequest<Omit<MulliganSingleRequest, 'id'>, MulliganSingleSuccess | MulliganFailure>(
    workerRef.current,
    request,
    (r) => (r.ok ? { strategy: r.strategy, curves: r.curves } : null),
  );

  const typedData = data as WorkerData | null;
  const value: MulliganStrategyState = {
    result: typedData?.strategy ?? null,
    curves: typedData?.curves ?? null,
    tooLarge: error,
    loading,
  };

  return <MulliganCtx.Provider value={value}>{children}</MulliganCtx.Provider>;
}

export function useMulliganStrategyCtx(): MulliganStrategyState {
  const ctx = useContext(MulliganCtx);
  if (!ctx) throw new Error('useMulliganStrategyCtx must be used within MulliganStrategyProvider');
  return ctx;
}

/** Remaps a mulligan curve (indexed by extraDraws) onto the SAME "n = total
 * cards seen" x-axis the chart/table/grid already use everywhere else. For
 * n below handSize, there's no valid kept-hand state yet under this model
 * (mulliganing is a before-the-game decision, not a partial one) -- 0,
 * deliberately, rather than falling back to the raw curve's value there,
 * so the mulligan-adjusted view doesn't quietly blend two different
 * models together at the seam. */
export function mulliganCurveAtN(curves: MulliganCurveResult | null, handSize: number, n: number, useBest: boolean): number | null {
  if (!curves) return null;
  if (n < handSize) return 0;
  const curve = useBest ? curves.bestCurve : curves.neverMulliganCurve;
  const extraDraws = n - handSize;
  return extraDraws < curve.length ? curve[extraDraws]! : curve[curve.length - 1]!;
}

/** Builds a full-length curve (same length as the raw query curve) where
 * every index is the mulligan-adjusted value instead of the raw one --
 * this is what the chart/table/grid should render whenever mulligans>0,
 * so the whole line/table/heatmap reflects optimal mulligan play, not just
 * the one goal-turn point the advisor strip's condensed line shows. */
export function buildDisplayCurve(rawCurve: Curve, curves: MulliganCurveResult | null, handSize: number): Curve {
  if (!curves) return rawCurve;
  const out = new Float64Array(rawCurve.length);
  for (let n = 0; n < rawCurve.length; n++) {
    out[n] = mulliganCurveAtN(curves, handSize, n, true) ?? rawCurve[n]!;
  }
  return out;
}
