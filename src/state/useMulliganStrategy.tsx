/**
 * Shares the optimal-mulligan-strategy computation (src/math/mulligan.ts)
 * the same way useSuggestions.tsx shares the suggestion search -- computed
 * once per relevant state change, not independently re-run by every
 * component that wants to show it.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useAppState } from './AppState';
import { useQueryModelCtx } from './useQueryModel';
import { cardsSeenByTurn } from '../model/turns';
import {
  optimalMulliganStrategy, optimalMulliganCurve, MulliganTooLargeError,
  type MulliganResult, type MulliganCurveResult,
} from '../math/mulligan';
import type { Curve } from '../math/boxdp';

export interface MulliganStrategyState {
  /** null when mulligans=0 (nothing to compute/show) or the query is invalid. */
  result: MulliganResult | null;
  /** Whole-curve version, for the chart/table/grid -- indexed by extraDraws
   * (see MulliganCurveResult's own doc); null under the same conditions as
   * `result`. Computed alongside `result` (same recursion shape, aggregated
   * differently), not derived from it -- `result` needs the per-hand
   * breakdown the curve version aggregates away. */
  curves: MulliganCurveResult | null;
  tooLarge: string | null;
}

const MulliganCtx = createContext<MulliganStrategyState | null>(null);

export function MulliganStrategyProvider({ children }: { children: ReactNode }) {
  const { deckSize, turnCfg, target, adviseTurn } = useAppState();
  const { dnf, result: queryResult, sizes } = useQueryModelCtx();

  const value = useMemo<MulliganStrategyState>(() => {
    if (turnCfg.mulligans <= 0 || !dnf || !queryResult) return { result: null, curves: null, tooLarge: null };
    const handSize = turnCfg.openingHand;
    const totalSeen = Math.min(deckSize, cardsSeenByTurn(adviseTurn, turnCfg));
    const extraDraws = Math.max(0, totalSeen - handSize);
    try {
      const r = optimalMulliganStrategy(dnf, sizes, deckSize, handSize, extraDraws, turnCfg.mulligans);
      const c = optimalMulliganCurve(dnf, sizes, deckSize, handSize, turnCfg.mulligans);
      return { result: r, curves: c, tooLarge: null };
    } catch (e) {
      const message = e instanceof MulliganTooLargeError ? e.message : (e instanceof Error ? e.message : String(e));
      return { result: null, curves: null, tooLarge: message };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dnf, queryResult, sizes, deckSize, turnCfg, adviseTurn, target]);

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
