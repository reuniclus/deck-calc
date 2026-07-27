import { useAppState } from '../state/AppState';
import { useQueryModelCtx } from '../state/useQueryModel';
import { effectiveOpeningHand } from '../model/turns';

function pct(p: number): string {
  return `${(p * 100).toFixed(2)}%`;
}

export function ResultView() {
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

  const N = result.curve.length - 1;
  const W = 640, H = 200, PAD = 28;
  const x = (n: number) => PAD + (n / N) * (W - PAD - 8);
  const y = (p: number) => H - PAD - p * (H - PAD - 10);
  const points = Array.from(result.curve, (p, n) => `${x(n).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
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
      <p className="hint">
        {result.clauses} clause{result.clauses === 1 ? '' : 's'} &middot;{' '}
        {result.terms} term{result.terms === 1 ? '' : 's'} &middot;{' '}
        {result.monotone ? 'monotone' : 'non-monotone'} &middot; peak {pct(analysis.maxP)} at n={analysis.argmaxP}
      </p>
      <p>{summary}</p>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="probability curve">
        {[0.25, 0.5, 0.75, 1].map((p) => (
          <line key={p} x1={PAD} x2={W - 8} y1={y(p)} y2={y(p)} className="ax" />
        ))}
        <line x1={PAD} x2={W - 8} y1={y(target)} y2={y(target)} className="tgt" />
        {hand >= 0 && hand <= N && (
          <line x1={x(hand)} x2={x(hand)} y1={8} y2={H - PAD} className="hand" />
        )}
        <polyline points={points} className="curve-line" />
      </svg>
    </div>
  );
}
