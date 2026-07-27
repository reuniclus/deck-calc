/**
 * The suggestion search (frontier.ts's staircase or generalSuggest.ts's
 * brute-force, whichever suggestSearch.ts's dispatch picks) is the single
 * most expensive computation in the app -- measured directly: ~15ms for the
 * fast path, ~300ms for the general path (see chat history / commit log).
 * It used to run independently in three places (AdvisorStrip,
 * SuggestionsTab, and the chart's phantom curves) on every goal change --
 * that's not just wasteful, it already caused a real correctness bug once
 * (the three copies drifted out of sync). This computes it ONCE per
 * relevant state change and shares the result via context, the same
 * pattern useQueryModel.tsx already established for the main pipeline.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useAppState } from './AppState';
import { useQueryModelCtx } from './useQueryModel';
import { cardsSeenByTurn } from '../model/turns';
import { suggestVectors, SearchTooLargeError } from '../math/suggestSearch';
import type { GroupId } from '../math/expr';

export interface SuggestionsResult {
  /** Cards drawn by the chosen turn -- exposed since every consumer needs it
   * anyway and it's cheap to compute once here rather than three times. */
  n: number;
  vectors: Array<Record<GroupId, number>>;
  bestP: number;
  usedGeneralPath: boolean;
  /** Set only for a genuine SearchTooLargeError; other errors are treated
   * the same as "nothing found" (empty vectors) rather than surfaced, since
   * an unreachable target isn't an error condition. */
  searchTooLarge: string | null;
}

const SuggestionsCtx = createContext<SuggestionsResult | null>(null);

export function SuggestionsProvider({ children }: { children: ReactNode }) {
  const { deckSize, turnCfg, target, adviseTurn } = useAppState();
  const { dnf, ast, result } = useQueryModelCtx();

  const value = useMemo<SuggestionsResult>(() => {
    const n = Math.min(deckSize, cardsSeenByTurn(adviseTurn, turnCfg));
    if (!ast || !dnf || !result) return { n, vectors: [], bestP: 0, usedGeneralPath: false, searchTooLarge: null };
    // Always run the real search, even if the current deck already reaches
    // target -- that's the only way to learn whether the CURRENT composition
    // is over-provisioned (a smaller one might still clear the bar). Skipping
    // it would silently hide that from SuggestionsTab. AdvisorStrip decides
    // its own "already there" framing separately and cheaply, from
    // result.curve[n] directly, without needing this shared layer to bake
    // in a shortcut that would affect every other consumer too.
    try {
      const { vectors, bestP, usedGeneralPath } = suggestVectors(ast, dnf, deckSize, n, target);
      return { n, vectors, bestP, usedGeneralPath, searchTooLarge: null };
    } catch (e) {
      const message = e instanceof SearchTooLargeError ? e.message : (e instanceof Error ? e.message : String(e));
      return { n, vectors: [], bestP: 0, usedGeneralPath: true, searchTooLarge: message };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ast, dnf, result, deckSize, adviseTurn, turnCfg, target]);

  return <SuggestionsCtx.Provider value={value}>{children}</SuggestionsCtx.Provider>;
}

export function useSuggestionsCtx(): SuggestionsResult {
  const ctx = useContext(SuggestionsCtx);
  if (!ctx) throw new Error('useSuggestionsCtx must be used within SuggestionsProvider');
  return ctx;
}
