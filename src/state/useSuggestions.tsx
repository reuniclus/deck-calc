/**
 * The suggestion search is the single most expensive computation in the app
 * -- measured directly: ~15ms for the fast path (frontier.ts's staircase),
 * ~300ms for the general path (generalSuggest.ts's brute-force). It used to
 * run independently in three places (AdvisorStrip, SuggestionsTab, and the
 * chart's phantom curves) on every goal change -- that's not just wasteful,
 * it already caused a real correctness bug once (the three copies drifted
 * out of sync). This computes it ONCE per relevant state change and shares
 * the result via context, the same pattern useQueryModel.tsx established
 * for the main pipeline.
 *
 * For the general path specifically, this ALSO exploits a second property:
 * the brute-force enumeration itself (every composition's full curve) does
 * not depend on n/target at all -- only which curve VALUE counts as a "hit"
 * does. So changing the goal on the SAME deck+query doesn't need to
 * re-enumerate and re-evaluate every composition from scratch; it can reuse
 * the previously-enumerated curves and just re-scan them at the new
 * threshold (enumerateCompositionCurves is the expensive nested memo below;
 * pickMinimalVectors is the cheap one layered on top of it).
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useAppState } from './AppState';
import { useQueryModelCtx } from './useQueryModel';
import { cardsSeenByTurn } from '../model/turns';
import { minimalVectors } from '../math/frontier';
import {
  enumerateCompositionCurves, pickMinimalVectors, SearchTooLargeError,
} from '../math/generalSuggest';
import { collectGroups } from '../math/expr';
import type { Box, GroupId } from '../math/expr';

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

  const fastPath = !!dnf && dnf.monotone && dnf.clauses.length === 1;
  const groupIds = useMemo(() => (ast ? [...collectGroups(ast)] : []), [ast]);

  // Nested memo: the EXPENSIVE part (every composition's full curve for the
  // general path) is keyed ONLY on ast/deckSize/groupIds -- NOT target or n
  // -- so it survives goal changes on the same deck+query untouched. Only
  // relevant/computed when the fast path doesn't apply.
  const compositionCurves = useMemo(() => {
    if (!ast || fastPath || groupIds.length === 0) return { ok: true as const, curves: [] };
    try {
      return { ok: true as const, curves: enumerateCompositionCurves(ast, groupIds, deckSize, {}) };
    } catch (e) {
      const message = e instanceof SearchTooLargeError ? e.message : (e instanceof Error ? e.message : String(e));
      return { ok: false as const, message };
    }
  }, [ast, fastPath, groupIds, deckSize]);

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
    if (fastPath) {
      if (groupIds.length === 0) return { n, vectors: [], bestP: 1, usedGeneralPath: false, searchTooLarge: null };
      if (groupIds.length > 4) {
        return { n, vectors: [], bestP: 0, usedGeneralPath: false, searchTooLarge: `${groupIds.length} groups in one clause -- capped at 4` };
      }
      const clause: Box = dnf!.clauses[0]!;
      const searchClause: Record<GroupId, { lo: number; hi: number }> = {};
      for (const gid of groupIds) searchClause[gid] = { lo: clause[gid]?.lo ?? 0, hi: deckSize };
      try {
        const { vectors, bestP } = minimalVectors(searchClause, n, deckSize, target);
        return { n, vectors, bestP, usedGeneralPath: false, searchTooLarge: null };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { n, vectors: [], bestP: 0, usedGeneralPath: false, searchTooLarge: message };
      }
    }

    if (!compositionCurves.ok) {
      return { n, vectors: [], bestP: 0, usedGeneralPath: true, searchTooLarge: compositionCurves.message };
    }
    const { vectors, bestP } = pickMinimalVectors(compositionCurves.curves, groupIds, n, target);
    return { n, vectors, bestP, usedGeneralPath: true, searchTooLarge: null };
  }, [ast, dnf, result, deckSize, adviseTurn, turnCfg, target, fastPath, groupIds, compositionCurves]);

  return <SuggestionsCtx.Provider value={value}>{children}</SuggestionsCtx.Provider>;
}

export function useSuggestionsCtx(): SuggestionsResult {
  const ctx = useContext(SuggestionsCtx);
  if (!ctx) throw new Error('useSuggestionsCtx must be used within SuggestionsProvider');
  return ctx;
}
