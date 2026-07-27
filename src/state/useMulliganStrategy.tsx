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
import { optimalMulliganStrategy, MulliganTooLargeError, type MulliganResult } from '../math/mulligan';

export interface MulliganStrategyState {
  /** null when mulligans=0 (nothing to compute/show) or the query is invalid. */
  result: MulliganResult | null;
  tooLarge: string | null;
}

const MulliganCtx = createContext<MulliganStrategyState | null>(null);

export function MulliganStrategyProvider({ children }: { children: ReactNode }) {
  const { deckSize, turnCfg, target, adviseTurn } = useAppState();
  const { dnf, result: queryResult, sizes } = useQueryModelCtx();

  const value = useMemo<MulliganStrategyState>(() => {
    if (turnCfg.mulligans <= 0 || !dnf || !queryResult) return { result: null, tooLarge: null };
    const handSize = turnCfg.openingHand;
    const totalSeen = Math.min(deckSize, cardsSeenByTurn(adviseTurn, turnCfg));
    const extraDraws = Math.max(0, totalSeen - handSize);
    try {
      const r = optimalMulliganStrategy(dnf, sizes, deckSize, handSize, extraDraws, turnCfg.mulligans);
      return { result: r, tooLarge: null };
    } catch (e) {
      const message = e instanceof MulliganTooLargeError ? e.message : (e instanceof Error ? e.message : String(e));
      return { result: null, tooLarge: message };
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
