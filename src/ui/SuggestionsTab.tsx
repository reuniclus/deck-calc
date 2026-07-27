import { useMemo } from 'react';
import { useAppState } from '../state/AppState';
import { useQueryModelCtx, nameOfFactory } from '../state/useQueryModel';
import { cardsSeenByTurn } from '../model/turns';
import { colorFor } from './DeckEditor';
import { minimalVectors } from '../math/frontier';
import { allocate, minSlotsForTarget } from '../math/allocate';
import { generalMinimalVectors, SearchTooLargeError } from '../math/generalSuggest';
import { collectGroups } from '../math/expr';
import type { Box } from '../math/expr';

function pct(p: number): string {
  return `${(p * 100).toFixed(2)}%`;
}

/**
 * The full breakdown behind the advisor strip's condensed line.
 *
 * "Every minimal vector" (the table) works for ANY query shape: single
 * AND-clause uses the fast monotone staircase (frontier.ts); OR/non-monotone
 * queries fall back to a bounded general brute-force search
 * (generalSuggest.ts) -- a genuinely different algorithm, not the same one
 * silently reused past its assumptions.
 *
 * "Best split of current slots" / "fewest slots" (allocate.ts) are NOT
 * generalized here -- they rely on monotonicity for THEIR OWN correctness
 * (a budget-optimal split assumes more copies never hurts), which doesn't
 * hold once a clause can be negated. Shown only for the monotone single-
 * clause case; said so explicitly rather than silently omitted.
 */
export function SuggestionsTab() {
  const { groups, deckSize, turnCfg, target, adviseTurn } = useAppState();
  const { dnf, ast, error } = useQueryModelCtx();
  const nameOf = nameOfFactory(groups);
  const n = Math.min(deckSize, cardsSeenByTurn(adviseTurn, turnCfg));

  const scoped = useMemo(() => {
    if (!dnf || !ast) return null;
    const fastPath = dnf.monotone && dnf.clauses.length === 1;
    const groupIds = [...collectGroups(ast)];
    if (groupIds.length === 0) return { kind: 'unconstrained' as const };
    if (groupIds.length > 4) return { kind: 'too-many' as const, count: groupIds.length };

    try {
      let frontier: { vectors: Array<Record<string, number>>; bestP: number };
      let alloc: ReturnType<typeof allocate> | null = null;
      let dual: ReturnType<typeof minSlotsForTarget> | null = null;
      let baseline = 0;
      const currentSpend = groupIds.reduce((s, g) => s + (groups.find((x) => x.id === g)?.count ?? 0), 0);

      if (fastPath) {
        const clause: Box = dnf.clauses[0]!;
        const searchClause: Record<string, { lo: number; hi: number }> = {};
        for (const gid of groupIds) searchClause[gid] = { lo: clause[gid]?.lo ?? 0, hi: deckSize };
        frontier = minimalVectors(searchClause, n, deckSize, target);
        alloc = groupIds.length >= 2 ? allocate(searchClause, n, deckSize, currentSpend) : null;
        dual = groupIds.length >= 2 ? minSlotsForTarget(searchClause, n, deckSize, target) : null;
        baseline = groupIds.reduce((s, g) => s + (clause[g]?.lo ?? 0), 0);
      } else {
        frontier = generalMinimalVectors(ast, groupIds, deckSize, n, target, {});
      }
      return { kind: 'ok' as const, fastPath, groupIds, frontier, alloc, dual, baseline, currentSpend };
    } catch (e) {
      if (e instanceof SearchTooLargeError) return { kind: 'too-large' as const, message: e.message };
      return { kind: 'error' as const, message: e instanceof Error ? e.message : String(e) };
    }
  }, [dnf, ast, n, deckSize, target, groups]);

  if (error) return <p className="hint bad">{error}</p>;
  if (!scoped) return null;
  if (scoped.kind === 'unconstrained') return <p className="hint">No group is constrained &mdash; nothing to suggest.</p>;
  if (scoped.kind === 'too-many') return <p className="hint">{scoped.count} groups referenced &mdash; search is capped at 4 for now.</p>;
  if (scoped.kind === 'too-large') return <p className="hint flag">{scoped.message}</p>;
  if (scoped.kind === 'error') return <p className="hint bad">{scoped.message}</p>;

  const { fastPath, groupIds, frontier, alloc, dual, baseline, currentSpend } = scoped;

  return (
    <div>
      <p className="hint">Target {pct(target)} by turn {adviseTurn} (n={n} cards drawn):</p>
      {!fastPath && (
        <p className="hint">
          This query has an OR or a NOT, so there's no shortcut search available &mdash; every combination below
          was checked directly (bounded to {groupIds.length} groups).
        </p>
      )}

      {frontier.vectors.length === 0 ? (
        <p className="hint flag">
          Not reachable at {n} cards drawn within the searched range (best {pct(frontier.bestP)}).
        </p>
      ) : (
        <>
          <table className="num-table">
            <thead>
              <tr>{groupIds.map((g) => <th key={g} style={{ color: colorFor(g) }}>{nameOf(g)}</th>)}</tr>
            </thead>
            <tbody>
              {frontier.vectors
                .slice()
                .sort((a, b) => groupIds.reduce((s, g) => s + a[g]! - b[g]!, 0))
                .map((v, i) => (
                  <tr key={i}>{groupIds.map((g) => <td key={g}>{v[g]}</td>)}</tr>
                ))}
            </tbody>
          </table>
          <p className="hint">
            Each row is a minimal combination &mdash; none can be trimmed further without dropping below {pct(target)}.
            All are genuine tradeoffs, not ranked.
          </p>
        </>
      )}

      {fastPath && alloc && dual ? (
        <div style={{ marginTop: 12 }}>
          <p className="hint">
            <b>Best split of your current {currentSpend} slots</b> ({groupIds.map((g) => nameOf(g)).join(' + ')}):{' '}
            {groupIds.map((g) => `${nameOf(g)}: ${alloc.best[g]}`).join(', ')} &rarr; {pct(alloc.bestP)}
            {!alloc.exact && <span className="hint"> (heuristic, not exhaustive)</span>}
          </p>
          <p className="hint">
            <b>Fewest slots for {pct(target)}:</b>{' '}
            {dual.extraSlots === null
              ? `never reaches ${pct(target)} within the searched caps (best ${pct(dual.bestP)})`
              : <>{groupIds.map((g) => `${nameOf(g)}: ${dual.best?.[g]}`).join(', ')} &mdash; {dual.extraSlots} slot{dual.extraSlots === 1 ? '' : 's'} beyond the {baseline}-card minimum</>}
          </p>
        </div>
      ) : !fastPath && (
        <p className="hint" style={{ marginTop: 12 }}>
          &quot;Best split&quot; and &quot;fewest slots&quot; aren&apos;t shown for OR/NOT queries &mdash; those
          specifically assume more copies never hurts, which isn&apos;t true once something can be negated.
        </p>
      )}
    </div>
  );
}
