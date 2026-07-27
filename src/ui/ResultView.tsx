import { useAppState } from '../state/AppState';
import { useQueryModelCtx } from '../state/useQueryModel';
import { effectiveOpeningHand, turnForCardsSeen } from '../model/turns';
import type { analyze } from '../math/analyze';
import { GridTab } from './GridTab';
import { SuggestionsTab } from './SuggestionsTab';

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

function tickValues(N: number): number[] {
  const step = N <= 20 ? 5 : N <= 60 ? 10 : 25;
  const out: number[] = [];
  for (let n = 0; n <= N; n += step) out.push(n);
  return out;
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
      {Array.from({ length: N + 1 }, (_, n) => n).map((n) => (
        <line key={`v${n}`} x1={x(n)} x2={x(n)} y1={8} y2={H - PAD} className={n % 5 === 0 ? 'vax5' : 'vax'} />
      ))}
      {[0.25, 0.5, 0.75, 1].map((p) => (
        <line key={p} x1={PAD} x2={W - 8} y1={y(p)} y2={y(p)} className="ax" />
      ))}
      {[0.25, 0.5, 0.75, 1].map((p) => (
        <text key={`lbl${p}`} x={2} y={y(p) + 4} className="lbl">{Math.round(p * 100)}%</text>
      ))}
      <line x1={PAD} x2={W - 8} y1={y(target)} y2={y(target)} className="tgt" />
      {hand >= 0 && hand <= N && <line x1={x(hand)} x2={x(hand)} y1={8} y2={H - PAD} className="hand" />}
      <polyline points={points} className="curve-line" />
      {tickValues(N).map((n) => (
        <text key={`tick${n}`} x={x(n)} y={H - 8} className="lbl mid">{n}</text>
      ))}
      <text x={W / 2} y={H - 8} className="lbl mid dim-lbl">cards drawn</text>
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

export type ResultTab = 'chart' | 'table' | 'grid' | 'suggestions';

export function ResultView({ tab, setTab }: { tab: ResultTab; setTab: (t: ResultTab) => void }) {
  const { turnCfg, target } = useAppState();
  const { error, result, analysis } = useQueryModelCtx();

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
    const w = analysis.windows.map(([s, e]) => (s === e ? `${s}` : `${s}–${e}`)).join(', ');
    summary = `P ≥ ${pct(target)} only for n ∈ {${w}} — a bounded window, because the query is capped above.`;
  }

  return (
    <div className="panel">
      <p className="hint" style={{ margin: 0 }}>
        {result.clauses} clause{result.clauses === 1 ? '' : 's'} &middot;{' '}
        {result.terms} term{result.terms === 1 ? '' : 's'} &middot;{' '}
        {result.monotone ? 'monotone' : 'non-monotone'} &middot; peak {pct(analysis.maxP)} at n={analysis.argmaxP}
      </p>
      <p>{summary}</p>

      <div className="tab-strip">
        <button className={tab === 'chart' ? 'active' : ''} onClick={() => setTab('chart')}>Chart</button>
        <button className={tab === 'table' ? 'active' : ''} onClick={() => setTab('table')}>Table</button>
        <button className={tab === 'grid' ? 'active' : ''} onClick={() => setTab('grid')}>Grid</button>
        <button className={tab === 'suggestions' ? 'active' : ''} onClick={() => setTab('suggestions')}>Suggestions</button>
      </div>
      {/* All tabs stay mounted, toggled via display -- switching tabs must not
          reset a tab's own local state (e.g. Grid's swept-group selection). */}
      <div className="tab-panel-chart" style={{ display: tab === 'chart' ? 'block' : 'none' }}>
        <ChartTab result={result} hand={hand} target={target} />
      </div>
      <div className="tab-panel-table" style={{ display: tab === 'table' ? 'block' : 'none' }}>
        <TableTab result={result} analysis={analysis} hand={hand} turnCfg={turnCfg} />
      </div>
      <div className="tab-panel-grid" style={{ display: tab === 'grid' ? 'block' : 'none' }}>
        <GridTab />
      </div>
      <div className="tab-panel-suggestions" style={{ display: tab === 'suggestions' ? 'block' : 'none' }}>
        <SuggestionsTab />
      </div>
    </div>
  );
}
