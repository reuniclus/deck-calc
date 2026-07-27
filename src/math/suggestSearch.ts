/**
 * Single shared dispatch between the fast monotone/single-clause staircase
 * (frontier.ts) and the general bounded brute-force search
 * (generalSuggest.ts). This logic was duplicated independently in
 * AdvisorStrip, SuggestionsTab, and the chart's phantom-curve computation --
 * and it already drifted once: when general-path support was added, the
 * chart's copy was never updated, so phantom lines silently stopped
 * appearing for any OR/non-monotone query even though the advisor strip and
 * Suggestions tab correctly showed real suggestions for the exact same
 * query. One shared function, one place to keep it correct.
 */
import { minimalVectors } from './frontier';
import { generalMinimalVectors, SearchTooLargeError } from './generalSuggest';
import { collectGroups } from './expr';
import type { Box, Dnf, Expr, GroupId } from './expr';

export { SearchTooLargeError };

export interface SuggestSearchResult {
  vectors: Array<Record<GroupId, number>>;
  bestP: number;
  /** Which algorithm actually ran -- surfaced so callers can show an honest
   * "no shortcut available" note for the general path without re-deriving
   * dnf.monotone/clauses.length themselves. */
  usedGeneralPath: boolean;
}

export function suggestVectors(
  ast: Expr,
  dnf: Dnf,
  deckSize: number,
  n: number,
  target: number,
): SuggestSearchResult {
  const fastPath = dnf.monotone && dnf.clauses.length === 1;
  if (fastPath) {
    const clause: Box = dnf.clauses[0]!;
    const groupIds = Object.keys(clause);
    if (groupIds.length === 0) return { vectors: [], bestP: 1, usedGeneralPath: false };
    if (groupIds.length > 4) {
      throw new SearchTooLargeError(`${groupIds.length} groups in one clause -- capped at 4`);
    }
    const searchClause: Record<GroupId, { lo: number; hi: number }> = {};
    for (const gid of groupIds) searchClause[gid] = { lo: clause[gid]!.lo, hi: deckSize };
    const { vectors, bestP } = minimalVectors(searchClause, n, deckSize, target);
    return { vectors, bestP, usedGeneralPath: false };
  }
  const groupIds = [...collectGroups(ast)];
  const { vectors, bestP } = generalMinimalVectors(ast, groupIds, deckSize, n, target, {});
  return { vectors, bestP, usedGeneralPath: true };
}
