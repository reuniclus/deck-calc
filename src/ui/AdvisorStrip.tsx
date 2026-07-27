import { useAppDispatch, useAppState } from '../state/AppState';
import { useQueryModelCtx, nameOfFactory } from '../state/useQueryModel';
import { colorFor } from './DeckEditor';
import { parseNumOr0 } from './numberInput';
import { collectGroups } from '../math/expr';
import { useSuggestionsCtx } from '../state/useSuggestions';

function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

/** Smallest total change from the CURRENT deck, not from the query's own
 * `lo` requirement -- different clauses in an OR can have different `lo`
 * for the same group, so there's no single shared baseline to compare
 * against except what's actually in the deck right now. */
function closestToCurrent(
  vectors: Array<Record<string, number>>,
  groupIds: string[],
  currentOf: (g: string) => number,
): Record<string, number> {
  return vectors.reduce((best, cur) => {
    const bestDelta = groupIds.reduce((s, g) => s + Math.abs(best[g]! - currentOf(g)), 0);
    const curDelta = groupIds.reduce((s, g) => s + Math.abs(cur[g]! - currentOf(g)), 0);
    return curDelta < bestDelta ? cur : best;
  }, vectors[0]!);
}

/**
 * Persistent above the curve, visible regardless of which tab is active --
 * the advisor's whole value is being the "so what do I do" answer, which
 * shouldn't need a click to see (see UI_DESIGN.md §3). The inputs stay live
 * regardless of query shape. "Draw longer" ALWAYS works (analyze() doesn't
 * care about clause structure); "add copies" uses the fast monotone/single-
 * clause staircase (frontier.ts) when it applies, falling back to a general
 * bounded brute-force search (generalSuggest.ts) for OR/non-monotone
 * queries -- NOT the same algorithm silently reused past its assumptions.
 */
export function AdvisorStrip({ onSeeSuggestions }: { onSeeSuggestions: () => void }) {
  const { groups, turnCfg, target, adviseTurn } = useAppState();
  const dispatch = useAppDispatch();
  const { dnf, result, analysis, ast } = useQueryModelCtx();
  const { n, vectors, searchTooLarge } = useSuggestionsCtx();
  const nameOf = nameOfFactory(groups);
  const currentOf = (g: string) => groups.find((x) => x.id === g)?.count ?? 0;

  // Direct dispatch on every keystroke -- the underlying recompute is cheap
  // now (see useQueryModel.tsx/useSuggestions.tsx: target no longer re-runs
  // the expensive base pipeline, and the general search's enumeration is
  // cached across goal changes on the same deck+query), so there's no
  // longer a real cost to debounce against. A debounce was only ever a
  // workaround for expensive recomputation, not a goal in itself.
  if (!result || !analysis || !dnf || !ast) {
    return (
      <div className="panel advisor-strip">
        <p className="hint">Enter a valid query to see advice.</p>
      </div>
    );
  }

  const already = result.curve[n]! >= target - 1e-12;
  const drawPart = already
    ? 'Already there with today\u2019s deck.'
    : analysis.drawsNeeded !== null
    ? `Draw ${analysis.drawsNeeded} cards (${analysis.drawsNeeded - n} more).`
    : `Won\u2019t reach it by drawing alone (best ${pct(analysis.maxP)}).`;

  const groupIdsUsed = [...collectGroups(ast)];
  const copyPart = already || vectors.length === 0 ? null : (() => {
    const v = closestToCurrent(vectors, groupIdsUsed, currentOf);
    return groupIdsUsed
      .filter((g) => v[g]! > currentOf(g))
      .map((g) => <span key={g} style={{ color: colorFor(g) }}> {v[g]! - currentOf(g)} {nameOf(g)}</span>);
  })();

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
      <p style={{ margin: 0 }}>
        {drawPart}
        {copyPart && copyPart.length > 0 && <> Or add{copyPart}.</>}
        {searchTooLarge && <span className="hint"> (copy suggestions unavailable: {searchTooLarge})</span>}
        {' '}
        <button className="link-btn" onClick={onSeeSuggestions}>See suggestions &rarr;</button>
      </p>
    </div>
  );
}
