import { useMemo } from 'react';
import { useAppState } from '../state/AppState';
import { useQueryModelCtx, nameOfFactory } from '../state/useQueryModel';
import { useSuggestionsCtx } from '../state/useSuggestions';
import { colorFor } from './DeckEditor';
import { allocate, minSlotsForTarget } from '../math/allocate';
import { collectGroups } from '../math/expr';
import type { Box } from '../math/expr';

function pct(p: number): string {
  return `${(p * 100).toFixed(2)}%`;
}

/**
 * The full breakdown behind the advisor strip's condensed line. The
 * expensive part (every minimal vector) comes from the SHARED
 * useSuggestionsCtx() -- computed once regardless of how many components
 * need it, not re-run here independently (that duplication is exactly what
 * caused a real correctness bug once already, see suggestSearch.ts).
 *
 * "Best split of current slots" / "fewest slots" (allocate.ts) are NOT
 * generalized -- they rely on monotonicity for THEIR OWN correctness (a
 * budget-optimal split assumes more copies never hurts), which doesn't hold
 * once a clause can be negated. Shown only for the monotone single-clause
 * case; said so explicitly rather than silently omitted. These are cheap
 * (allocate.ts, not the search), so still computed locally here.
 */
export function SuggestionsTab() {
  const { groups, deckSize, target, adviseTurn } = useAppState();
  const { dnf, ast, error } = useQueryModelCtx();
  const { n, vectors, bestP, usedGeneralPath, searchTooLarge } = useSuggestionsCtx();
  const nameOf = nameOfFactory(groups);

  const groupIds = useMemo(() => (ast ? [...collectGroups(ast)] : []), [ast]);
  const fastPath = !!dnf && dnf.monotone && dnf.clauses.length === 1;

  const allocInfo = useMemo(() => {
    if (!dnf || !fastPath || groupIds.length < 2 || groupIds.length > 4) return null;
    const clause: Box = dnf.clauses[0]!;
    const searchClause: Record<string, { lo: number; hi: number }> = {};
    for (const gid of groupIds) searchClause[gid] = { lo: clause[gid]?.lo ?? 0, hi: deckSize };
    const currentSpend = groupIds.reduce((s, g) => s + (groups.find((x) => x.id === g)?.count ?? 0), 0);
    return {
      alloc: allocate(searchClause, n, deckSize, currentSpend),
      dual: minSlotsForTarget(searchClause, n, deckSize, target),
      baseline: groupIds.reduce((s, g) => s + (clause[g]?.lo ?? 0), 0),
      currentSpend,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dnf, fastPath, groupIds, deckSize, n, target, groups]);

  if (error) return <p className="hint bad">{error}</p>;
  if (!dnf || !ast) return null;
  if (groupIds.length === 0) return <p className="hint">No group is constrained &mdash; nothing to suggest.</p>;
  if (groupIds.length > 4) return <p className="hint">{groupIds.length} groups referenced &mdash; search is capped at 4 for now.</p>;
  if (searchTooLarge) return <p className="hint flag">{searchTooLarge}</p>;

  return (
    <div>
      <p className="hint">Target {pct(target)} by turn {adviseTurn} (n={n} cards drawn):</p>
      {usedGeneralPath && (
        <p className="hint">
          This query has an OR or a NOT, so there's no shortcut search available &mdash; every combination below
          was checked directly (bounded to {groupIds.length} groups).
        </p>
      )}

      {vectors.length === 0 ? (
        <p className="hint flag">
          Not reachable at {n} cards drawn within the searched range (best {pct(bestP)}).
        </p>
      ) : (
        <>
          <table className="num-table">
            <thead>
              <tr>{groupIds.map((g) => <th key={g} style={{ color: colorFor(g) }}>{nameOf(g)}</th>)}</tr>
            </thead>
            <tbody>
              {vectors
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

      {allocInfo ? (
        <div style={{ marginTop: 12 }}>
          <p className="hint">
            <b>Best split of your current {allocInfo.currentSpend} slots</b> ({groupIds.map((g) => nameOf(g)).join(' + ')}):{' '}
            {groupIds.map((g) => `${nameOf(g)}: ${allocInfo.alloc.best[g]}`).join(', ')} &rarr; {pct(allocInfo.alloc.bestP)}
            {!allocInfo.alloc.exact && <span className="hint"> (heuristic, not exhaustive)</span>}
          </p>
          <p className="hint">
            <b>Fewest slots for {pct(target)}:</b>{' '}
            {allocInfo.dual.extraSlots === null
              ? `never reaches ${pct(target)} within the searched caps (best ${pct(allocInfo.dual.bestP)})`
              : <>{groupIds.map((g) => `${nameOf(g)}: ${allocInfo.dual.best?.[g]}`).join(', ')} &mdash; {allocInfo.dual.extraSlots} slot{allocInfo.dual.extraSlots === 1 ? '' : 's'} beyond the {allocInfo.baseline}-card minimum</>}
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
