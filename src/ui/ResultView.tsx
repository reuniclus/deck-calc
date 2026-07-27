import { useMemo, useRef, useState } from 'react';
import { useAppState } from '../state/AppState';
import { useQueryModelCtx, nameOfFactory, sizesOf } from '../state/useQueryModel';
import { effectiveOpeningHand, turnForCardsSeen, cardsSeenByTurn } from '../model/turns';
import type { analyze } from '../math/analyze';
import { computeSuggestionCurves } from '../state/suggestionCurves';
import { evaluate } from '../math/evaluate';
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

function ChartTab() {
  const { groups, deckSize, turnCfg, target, adviseTurn } = useAppState();
  const { dnf, result, ast } = useQueryModelCtx();
  const [hover, setHover] = useState<{ n: number; seriesIdx: number; clientX: number; clientY: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const hand = effectiveOpeningHand(turnCfg);
  const N = result ? result.curve.length - 1 : 0;
  const turnN = Math.min(N, cardsSeenByTurn(adviseTurn, turnCfg));
  const nameOf = nameOfFactory(groups);

  const suggestions = useMemo(() => {
    if (!ast || !dnf || !result || !dnf.monotone || dnf.clauses.length !== 1) return [];
    const clause = dnf.clauses[0]!;
    return computeSuggestionCurves(ast, clause, deckSize, turnN, target, sizesOf(groups));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ast, dnf, result, deckSize, turnN, target, groups]);

  // Each clause's OWN curve, as if it were the only requirement -- this is
  // ALWAYS computable regardless of monotonicity or clause count (a single
  // box is just evaluate() with a one-clause DNF, no inclusion-exclusion
  // needed), unlike the suggestion search above which needs the monotone/
  // single-clause fast path.
  const clauseCurves = useMemo(() => {
    if (!dnf || dnf.clauses.length <= 1) return [];
    const sizes = sizesOf(groups);
    return dnf.clauses.map((clause) => {
      try {
        return evaluate(deckSize, sizes, { clauses: [clause], monotone: true }).curve;
      } catch {
        return null;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dnf, deckSize, groups]);

  if (!result) return null;

  const W = 640, H = 200, PAD = 28;
  const x = (n: number) => PAD + (n / N) * (W - PAD - 8);
  const y = (p: number) => H - PAD - p * (H - PAD - 10);

  const vectorLabel = (v: Record<string, number>): string =>
    Object.entries(v).map(([g, c]) => `${c} ${nameOf(g)}`).join(', ');

  // One unified list drives hit-testing, line rendering, the pip, AND the
  // tooltip -- a single source of truth for "what lines exist right now",
  // so none of those four things can silently disagree with each other.
  interface Series { key: string; label: string; curve: Float64Array; baseOpacity: number; className: string }
  const series: Series[] = [
    { key: 'main', label: 'Current deck (any combo)', curve: result.curve, baseOpacity: 1, className: 'curve-line' },
    ...clauseCurves.flatMap((curve, i) => curve
      ? [{ key: `clause${i}`, label: `Combo ${i + 1}`, curve, baseOpacity: 0.35, className: 'clause-line' }]
      : []),
    ...suggestions.map((s, i) => ({
      key: `suggest${i}`,
      label: vectorLabel(s.vectors[0]!) + (s.vectors.length > 1 ? ` (or ${s.vectors.length - 1} more tied)` : ''),
      curve: s.curve,
      baseOpacity: 0.85 - i * 0.18,
      className: 'suggest-line',
    })),
  ];

  function handleMove(e: React.MouseEvent<SVGSVGElement>): void {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * W;
    const svgY = ((e.clientY - rect.top) / rect.height) * H;
    const n = Math.round(((svgX - PAD) / (W - PAD - 8)) * N);
    if (n < 0 || n > N) { setHover(null); return; }
    // Nearest LINE at this n, not just nearest column -- compares the mouse's
    // actual y against every series' y(curve[n]) and picks the closest one.
    let seriesIdx = 0, bestDist = Infinity;
    series.forEach((s, i) => {
      const d = Math.abs(y(s.curve[n]!) - svgY);
      if (d < bestDist) { bestDist = d; seriesIdx = i; }
    });
    setHover({ n, seriesIdx, clientX: e.clientX, clientY: e.clientY });
  }

  function opacityFor(idx: number): number {
    if (!hover) return series[idx]!.baseOpacity;
    return hover.seriesIdx === idx ? 1 : series[idx]!.baseOpacity * 0.3;
  }
  function strokeWidthFor(idx: number, base: number): number {
    return hover && hover.seriesIdx === idx ? base + 1 : base;
  }

  const hovered = hover ? series[hover.seriesIdx]! : null;

  return (
    <div style={{ position: 'relative' }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label="probability curve"
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      >
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
        {turnN >= 0 && turnN <= N && turnN !== hand && (
          <line x1={x(turnN)} x2={x(turnN)} y1={8} y2={H - PAD} className="turnline" />
        )}
        {/* Draw non-main series first, main last, so hover emphasis (and the
            main curve's own prominence) still ends up on top regardless of
            which one is currently boosted. */}
        {series.map((s, i) => s.key !== 'main' && (
          <polyline
            key={s.key}
            points={Array.from(s.curve, (p, n) => `${x(n).toFixed(1)},${y(p).toFixed(1)}`).join(' ')}
            className={s.className}
            style={{ opacity: opacityFor(i), strokeWidth: strokeWidthFor(i, s.className === 'clause-line' ? 1.5 : 1.5) }}
          />
        ))}
        <polyline
          points={Array.from(series[0]!.curve, (p, n) => `${x(n).toFixed(1)},${y(p).toFixed(1)}`).join(' ')}
          className="curve-line"
          style={{ opacity: opacityFor(0), strokeWidth: strokeWidthFor(0, 2.5) }}
        />
        {hover && <line x1={x(hover.n)} x2={x(hover.n)} y1={8} y2={H - PAD} className="hoverline" />}
        {hover && (
          <circle
            cx={x(hover.n)}
            cy={y(hovered!.curve[hover.n]!)}
            r={hovered!.key === 'main' ? 4 : 3.5}
            className={`hover-pip ${hovered!.key === 'main' ? 'main' : hovered!.className === 'suggest-line' ? 'suggest' : 'clause'}`}
          />
        )}
        {tickValues(N).map((n) => (
          <text key={`tick${n}`} x={x(n)} y={H - 8} className="lbl mid">{n}</text>
        ))}
        <text x={W / 2} y={H - 8} className="lbl mid dim-lbl">cards drawn</text>
      </svg>
      {hover && hovered && (
        <div
          className="chart-tooltip"
          style={{ position: 'fixed', left: hover.clientX, top: hover.clientY }}
        >
          <div className="hint">
            {hover.n} cards drawn{turnForCardsSeen(hover.n, turnCfg) !== null ? ` (turn ${turnForCardsSeen(hover.n, turnCfg)})` : ''}
          </div>
          <div>{hovered.label}: <b>{pct(hovered.curve[hover.n]!)}</b></div>
        </div>
      )}
    </div>
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
        <ChartTab />
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
