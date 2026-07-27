import { useState } from 'react';
import { useAppDispatch, useAppState } from '../state/AppState';
import { useQueryModelCtx } from '../state/useQueryModel';
import { effectiveOpeningHand, turnForCardsSeen } from '../model/turns';
import type { analyze } from '../math/analyze';
import { parseNumOr0 } from './numberInput';
import { GridTab } from './GridTab';

function pct(p: number): string {
  return `${(p * 100).toFixed(2)}%`;
}
function signed(p: number): string {
  return `${p >= 0 ? '+' : '\u2212'}${(Math.abs(p) * 100).toFixed(2)}%`;
}

/**
 * Steepest single-card gain, restricted to n >= the effective starting hand.
 * analyze() is deliberately turn-agnostic (no concept of an opening hand), so
 * its global knee can legitimately point BELOW the hand size -- the biggest
 * jump in a curve is often the very first card. Real bug, caught and fixed
 * once already this project (see UI_DESIGN.md / PLAN.md §3b) -- ported here
 * rather than reintroduced.
 */
function visibleKnee(a: ReturnType<typeof analyze>, start: number): number {
  const deltas = a.deltas;
  if (start >= deltas.length) return Math.max(0, deltas.length - 1);
  let knee = start;
  for (let n = start + 1; n < deltas.length; n++) if (deltas[n]! > deltas[knee]!) knee = n;
  return knee;
}

function ChartTab({
  result, hand, target,
}: {
  result: NonNullable<ReturnType<typeof useQueryModelCtx>['result']>;
  hand: number;
  target: number;
}) {
  const N = result.curve.length - 1;
  const W = 640, H = 200, PAD = 28;
  const x = (n: number) => PAD + (n / N) * (W - PAD - 8);
  const y = (p: number) => H - PAD - p * (H - PAD - 10);
  const points = Array.from(result.curve, (p, n) => `${x(n).toFixed(1)},${y(p).toFixed(1)}`).join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="probability curve">
      {[0.25, 0.5, 0.75, 1].map((p) => (
        <line key={p} x1={PAD} x2={W - 8} y1={y(p)} y2={y(p)} className="ax" />
      ))}
      <line x1={PAD} x2={W - 8} y1={y(target)} y2={y(target)} className="tgt" />
      {hand >= 0 && hand <= N && <line x1={x(hand)} x2={x(hand)} y1={8} y2={H - PAD} className="hand" />}
      <polyline points={points} className="curve-line" />
    </svg>
  );
}

function TableTab({
  result, analysis, hand, turnCfg,
}: {
  result: NonNullable<ReturnType<typeof useQueryModelCtx>['result']>;
  analysis: ReturnType<typeof analyze>;
  hand: number;
  turnCfg: ReturnType<typeof useAppState>['turnCfg'];
}) {
  const N = result.curve.length - 1;
  const start = Math.min(hand, N);
  const kneeN = visibleKnee(analysis, start) + 1;
  const rows = [];
  for (let n = start; n <= N; n++) {
    const hit = result.curve[n]! >= analysis.target - 1e-12;
    const isKnee = n === kneeN;
    const turn = turnForCardsSeen(n, turnCfg);
    rows.push(
      <tr key={n} className={hit ? 'hit' : ''}>
        <td>{n}</td>
        <td className="dim">{turn ?? ''}</td>
        <td>{pct(result.curve[n]!)}</td>
        <td className="dim">
          {n === start ? '' : signed(analysis.deltas[n - 1]!)}
          {isKnee ? ' \u25c2 steepest' : ''}
        </td>
      </tr>,
    );
  }
  return (
    <div className="table-scroll">
      <table className="num-table">
        <thead>
          <tr><th>drawn</th><th>turn</th><th>P</th><th>&Delta;P per card</th></tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}

export function ResultView() {
  const { turnCfg, target } = useAppState();
  const dispatch = useAppDispatch();
  const { error, result, analysis } = useQueryModelCtx();
  const [tab, setTab] = useState<'chart' | 'table' | 'grid'>('chart');

  if (error) {
    return (
      <div className="panel">
        <p className="hint bad">{error}</p>
      </div>
    );
  }
  if (!result || !analysis) return null;

  const hand = effectiveOpeningHand(turnCfg);

  let summary: string;
  if (analysis.windows.length === 0) {
    summary = `Never reaches ${pct(target)}. Best is ${pct(analysis.maxP)} at ${analysis.argmaxP} cards.`;
  } else if (analysis.monotone) {
    summary = `Reaches ${pct(target)} at ${analysis.drawsNeeded} cards drawn, and stays there.`;
  } else {
    const w = analysis.windows.map(([s, e]) => (s === e ? `${s}` : `${s}\u2013${e}`)).join(', ');
    summary = `P \u2265 ${pct(target)} only for n \u2208 {${w}} \u2014 a bounded window, because the query is capped above.`;
  }

  return (
    <div className="panel">
      <div className="row-line">
        <p className="hint" style={{ margin: 0 }}>
          {result.clauses} clause{result.clauses === 1 ? '' : 's'} &middot;{' '}
          {result.terms} term{result.terms === 1 ? '' : 's'} &middot;{' '}
          {result.monotone ? 'monotone' : 'non-monotone'} &middot; peak {pct(analysis.maxP)} at n={analysis.argmaxP}
        </p>
        <label className="inline-field" style={{ marginLeft: 'auto' }}>
          <span>Target</span>
          <input
            type="number"
            min={1}
            max={100}
            value={Math.round(target * 100)}
            onChange={(e) => {
              const v = parseNumOr0(e.target.value);
              dispatch({ type: 'setTarget', target: v / 100 });
            }}
          />
          <span>%</span>
        </label>
      </div>
      <p>{summary}</p>

      <div className="tab-strip">
        <button className={tab === 'chart' ? 'active' : ''} onClick={() => setTab('chart')}>Chart</button>
        <button className={tab === 'table' ? 'active' : ''} onClick={() => setTab('table')}>Table</button>
        <button className={tab === 'grid' ? 'active' : ''} onClick={() => setTab('grid')}>Grid</button>
      </div>
      {/* All tabs stay mounted, toggled via display -- switching tabs must not
          reset a tab's own local state (e.g. Grid's swept-group selection). */}
      <div style={{ display: tab === 'chart' ? 'block' : 'none' }}>
        <ChartTab result={result} hand={hand} target={target} />
      </div>
      <div style={{ display: tab === 'table' ? 'block' : 'none' }}>
        <TableTab result={result} analysis={analysis} hand={hand} turnCfg={turnCfg} />
      </div>
      <div style={{ display: tab === 'grid' ? 'block' : 'none' }}>
        <GridTab />
      </div>
    </div>
  );
}
