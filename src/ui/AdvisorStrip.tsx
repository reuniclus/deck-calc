import { useAppDispatch, useAppState } from '../state/AppState';
import { useQueryModelCtx, nameOfFactory } from '../state/useQueryModel';
import { cardsSeenByTurn } from '../model/turns';
import { colorFor } from './DeckEditor';
import { parseNumOr0 } from './numberInput';
import { minimalVectors } from '../math/frontier';
import type { Box } from '../math/expr';

function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

/**
 * Persistent above the curve, visible regardless of which tab is active --
 * the advisor's whole value is being the "so what do I do" answer, which
 * shouldn't need a click to see (see UI_DESIGN.md §3). Only single
 * monotone AND-clause queries are supported (same scope as the Suggestions
 * tab / frontier.ts): the inputs stay live regardless, only the advice line
 * dims when there's nothing to compute.
 */
export function AdvisorStrip({ onSeeSuggestions }: { onSeeSuggestions: () => void }) {
  const { groups, deckSize, turnCfg, target, adviseTurn } = useAppState();
  const dispatch = useAppDispatch();
  const { dnf, result, analysis, ast } = useQueryModelCtx();
  const nameOf = nameOfFactory(groups);

  const n = Math.min(deckSize, cardsSeenByTurn(adviseTurn, turnCfg));
  const available = dnf && dnf.monotone && dnf.clauses.length === 1 && result && analysis && ast;

  let advice: React.ReactNode = <span className="hint">Not available for this query shape (needs a single AND-clause, no OR/NOT).</span>;

  if (available) {
    const clause: Box = dnf.clauses[0]!;
    const groupIds = Object.keys(clause);
    const already = result.curve[n]! >= target - 1e-12;

    let vectors: ReturnType<typeof minimalVectors>['vectors'] = [];
    try {
      const searchClause: Record<string, { lo: number; hi: number }> = {};
      for (const gid of groupIds) searchClause[gid] = { lo: clause[gid]!.lo, hi: deckSize };
      ({ vectors } = groupIds.length > 0 && groupIds.length <= 4
        ? minimalVectors(searchClause, n, deckSize, target)
        : { vectors: [] });
    } catch {
      vectors = [];
    }

    const drawPart = already
      ? 'Already there with today\u2019s deck.'
      : analysis.drawsNeeded !== null
      ? `Draw ${analysis.drawsNeeded} cards (${analysis.drawsNeeded - n} more).`
      : `Won\u2019t reach it by drawing alone (best ${pct(analysis.maxP)}).`;

    const copyPart = already || vectors.length === 0 ? null : (() => {
      const v = vectors.reduce((best, cur) => {
        const bestDelta = groupIds.reduce((s, g) => s + Math.abs(best[g]! - (clause[g]!.lo)), 0);
        const curDelta = groupIds.reduce((s, g) => s + Math.abs(cur[g]! - (clause[g]!.lo)), 0);
        return curDelta < bestDelta ? cur : best;
      }, vectors[0]!);
      return groupIds
        .filter((g) => v[g]! > (groups.find((x) => x.id === g)?.count ?? 0))
        .map((g) => {
          const extra = v[g]! - (groups.find((x) => x.id === g)?.count ?? 0);
          return <span key={g} style={{ color: colorFor(g) }}> {extra} {nameOf(g)}</span>;
        });
    })();

    advice = (
      <>
        {drawPart}
        {copyPart && copyPart.length > 0 && <> Or add{copyPart}.</>}
        {' '}
        <button className="link-btn" onClick={onSeeSuggestions}>See suggestions &rarr;</button>
      </>
    );
  }

  return (
    <div className="panel advisor-strip">
      <div className="row-line" style={{ marginBottom: 4 }}>
        <span className="hint">Goal:</span>
        <input
          className="advisor-inline"
          type="number" min={1} max={100}
          value={Math.round(target * 100)}
          onChange={(e) => dispatch({ type: 'setTarget', target: parseNumOr0(e.target.value) / 100 })}
        />
        <span className="hint">success rate by turn</span>
        <input
          className="advisor-inline"
          type="number" min={0} max={60}
          value={adviseTurn}
          onChange={(e) => dispatch({ type: 'setAdviseTurn', adviseTurn: parseNumOr0(e.target.value) })}
        />
        <label className="inline-field" style={{ marginLeft: 6 }}>
          <input
            type="checkbox"
            checked={turnCfg.firstTurnDraw}
            onChange={(e) => dispatch({ type: 'setTurnCfg', turnCfg: { firstTurnDraw: e.target.checked } })}
          />
          <span className="hint">first turn draw</span>
        </label>
      </div>
      <p style={{ margin: 0 }}>{advice}</p>
    </div>
  );
}
