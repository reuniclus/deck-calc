import { useMemo } from 'react';
import { useAppState } from '../state/AppState';
import { useQueryModelCtx, nameOfFactory } from '../state/useQueryModel';
import { cardsSeenByTurn } from '../model/turns';
import { colorFor } from './DeckEditor';
import { minimalVectors } from '../math/frontier';
import { allocate, minSlotsForTarget } from '../math/allocate';
import type { Box } from '../math/expr';

function pct(p: number): string {
  return `${(p * 100).toFixed(2)}%`;
}

/**
 * The full breakdown behind the advisor strip's condensed line. Same scope
 * restriction (single monotone AND-clause) as the strip -- both derive from
 * the same math, this just shows every alternative instead of one summary.
 * Uses a SEARCH box with hi=deckSize, not the query's own box (whose hi is
 * bound to each group's CURRENT count) -- that distinction is a real, once-
 * confirmed bug: without it, the search could never suggest running MORE
 * copies than you already have (see PLAN.md/UI_DESIGN.md).
 */
export function SuggestionsTab() {
  const { groups, deckSize, turnCfg, target, adviseTurn } = useAppState();
  const { dnf, error } = useQueryModelCtx();
  const nameOf = nameOfFactory(groups);
  const n = Math.min(deckSize, cardsSeenByTurn(adviseTurn, turnCfg));

  const scoped = useMemo(() => {
    if (!dnf) return null;
    if (!dnf.monotone) return { kind: 'non-monotone' as const };
    if (dnf.clauses.length !== 1) return { kind: 'multi-clause' as const };
    const clause: Box = dnf.clauses[0]!;
    const groupIds = Object.keys(clause);
    if (groupIds.length === 0) return { kind: 'unconstrained' as const };
    if (groupIds.length > 4) return { kind: 'too-many' as const, count: groupIds.length };

    const searchClause: Record<string, { lo: number; hi: number }> = {};
    for (const gid of groupIds) searchClause[gid] = { lo: clause[gid]!.lo, hi: deckSize };

    try {
      const frontier = minimalVectors(searchClause, n, deckSize, target);
      const currentSpend = groupIds.reduce((s, g) => s + (groups.find((x) => x.id === g)?.count ?? 0), 0);
      const alloc = groupIds.length >= 2 ? allocate(searchClause, n, deckSize, currentSpend) : null;
      const dual = groupIds.length >= 2 ? minSlotsForTarget(searchClause, n, deckSize, target) : null;
      const baseline = groupIds.reduce((s, g) => s + clause[g]!.lo, 0);
      return { kind: 'ok' as const, groupIds, frontier, alloc, dual, baseline, currentSpend };
    } catch (e) {
      return { kind: 'error' as const, message: e instanceof Error ? e.message : String(e) };
    }
  }, [dnf, n, deckSize, target, groups]);

  if (error) return <p className="hint bad">{error}</p>;
  if (!scoped) return null;
  if (scoped.kind === 'non-monotone') {
    return <p className="hint flag">Only available for monotone queries (every group used as &ge;, no NOT). This query has an upper bound somewhere, so "fewest slots" isn&apos;t well posed.</p>;
  }
  if (scoped.kind === 'multi-clause') {
    return <p className="hint">Only available for a single AND-clause (no OR) right now &mdash; allocation across branches of an OR is a separate question.</p>;
  }
  if (scoped.kind === 'unconstrained') return <p className="hint">No group is constrained &mdash; nothing to suggest.</p>;
  if (scoped.kind === 'too-many') return <p className="hint">{scoped.count} groups in one clause &mdash; allocation search is capped at 4 for now.</p>;
  if (scoped.kind === 'error') return <p className="hint bad">{scoped.message}</p>;

  const { groupIds, frontier, alloc, dual, baseline, currentSpend } = scoped;

  return (
    <div>
      <p className="hint">Target {pct(target)} by turn {adviseTurn} (n={n} cards drawn):</p>

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

      {alloc && dual && (
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
      )}
    </div>
  );
}
