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

  return (
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
        {mulliganResult.strategy
          .slice()
          .sort((a, b) => groupIds.reduce((s, g) => s + a.hand[g]! - b.hand[g]!, 0))
          .map((row, i) => (
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
  );
}
