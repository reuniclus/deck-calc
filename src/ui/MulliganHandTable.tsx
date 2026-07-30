/**
 * The per-hand keep/mulligan breakdown table, shared between SuggestionsTab
 * and QuestionsTab's "is my hand safe" card -- same data
 * (useMulliganStrategyCtx()), same table, rendered in two places rather
 * than computed twice. Deliberately just the table itself (plus its own
 * loading/error/gated states) -- the surrounding explanatory text differs
 * enough between the two callers (Suggestions wants the "optimal play
 * reaches X% vs Y%" summary line and the mulligan-count preamble; Questions
 * wants just the table under its own card title) that it isn't shared.
 */
import { useMemo } from 'react';
import { useAppState } from '../state/AppState';
import { useQueryModelCtx, nameOfFactory } from '../state/useQueryModel';
import { useMulliganStrategyCtx } from '../state/useMulliganStrategy';
import { collectGroups } from '../math/expr';
import { colorFor } from './DeckEditor';

function pct(p: number): string {
  return `${(p * 100).toFixed(2)}%`;
}

export function MulliganHandTable() {
  const { groups, turnCfg } = useAppState();
  const { ast } = useQueryModelCtx();
  const { result: mulliganResult, tooLarge: mulliganTooLarge, loading: mulliganLoading } = useMulliganStrategyCtx();
  const nameOf = nameOfFactory(groups);
  const groupIds = useMemo(() => (ast ? [...collectGroups(ast)] : []), [ast]);

  if (turnCfg.mulligans <= 0) {
    return <p className="hint">Set Mull. above 0 in the rail to see a keep/mulligan breakdown.</p>;
  }
  if (mulliganTooLarge) return <p className="hint flag">{mulliganTooLarge}</p>;
  if (!mulliganResult) {
    return mulliganLoading
      ? <p className="hint mulligan-loading">Computing optimal mulligan strategy&hellip;</p>
      : null;
  }

  const sortedRows = mulliganResult.strategy
    .slice()
    .sort((a, b) => groupIds.reduce((s, g) => s + a.hand[g]! - b.hand[g]!, 0));

  /**
   * Once every REMAINING hand (in this sorted order) is a "keep," listing
   * them all adds nothing -- confirmed directly from a real screenshot
   * where the tail was a long run of all-keep rows. Truncate right after
   * the LAST mulligan verdict rather than guessing at a threshold: the
   * keep/mulligan split isn't simply "more total cards is better" (two
   * hands with the same total can disagree, e.g. one group's copies being
   * worth more than another's) -- finding the actual last occurrence in
   * the computed data is correct by construction; assuming a pattern and
   * picking a cutoff point would not be.
   */
  const lastMulliganIndex = sortedRows.reduce((last, r, i) => (r.shouldKeep ? last : i), -1);
  const visibleRows = lastMulliganIndex === -1 ? [] : sortedRows.slice(0, lastMulliganIndex + 1);
  const hiddenCount = sortedRows.length - visibleRows.length;

  if (lastMulliganIndex === -1) {
    return <p className="hint">Every possible opening hand is safe to keep &mdash; there's no hand worth mulliganing here.</p>;
  }

  return (
    <>
      <table className="num-table">
        <thead>
          <tr>
            {groupIds.map((g) => <th key={g} style={{ color: colorFor(g) }}>{nameOf(g)}</th>)}
            <th>P(this hand)</th>
            <th>keep</th>
            <th>mulligan</th>
            <th>verdict</th>
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((row, i) => (
            <tr key={i} className={row.shouldKeep ? 'hit' : ''}>
              {groupIds.map((g) => <td key={g}>{row.hand[g]}</td>)}
              <td>{(row.probability * 100).toFixed(2)}%</td>
              <td>{pct(row.keepP)}</td>
              <td>{pct(row.mulliganP)}</td>
              <td>{row.shouldKeep ? 'keep' : 'mulligan'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {hiddenCount > 0 && (
        <p className="hint" style={{ margin: '4px 0 0' }}>
          + {hiddenCount} more hand{hiddenCount === 1 ? '' : 's'} beyond this point, all keep.
        </p>
      )}
    </>
  );
}
