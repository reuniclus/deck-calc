import { useMemo, useRef, useState } from 'react';
import { useAppState, type Group } from '../state/AppState';
import { useQueryModelCtx } from '../state/useQueryModel';
import { evaluate } from '../math/evaluate';
import { normalize } from '../math/normalize';
import type { Dnf, Sizes } from '../math/expr';
import { buildDisplayCurve } from '../state/useMulliganStrategy';
import { useWorkerRequest, type WorkerLike } from '../state/useWorkerRequest';
import { getMulliganWorker } from '../state/mulliganWorkerClient';
import type { MulliganBatchRequest, MulliganBatchSuccess, MulliganFailure } from '../workers/mulliganProtocol';
import { effectiveOpeningHand } from '../model/turns';
import { colorFor } from './DeckEditor';
import { NumberInput } from './NumberInput';

type Mode = 'value' | 'both';

/** Perceptual-ish dark->bright ramp for raw probabilities. Deliberately not a rainbow. */
function heat(p: number): string {
  const stops: Array<[number, number, number]> = [
    [12, 14, 24], [38, 52, 108], [30, 110, 130], [56, 168, 110], [180, 210, 70], [250, 240, 160],
  ];
  const t = Math.max(0, Math.min(1, p)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t));
  const f = t - i;
  const a = stops[i]!, b = stops[i + 1]!;
  const c = a.map((v, j) => Math.round(v + (b[j]! - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** Diverging scale for the interaction term: negative -> warm, positive -> cool, 0 -> neutral. */
function divHeat(d: number, maxAbs: number): string {
  const neutral: [number, number, number] = [30, 33, 40];
  const pos: [number, number, number] = [56, 168, 140];
  const neg: [number, number, number] = [210, 90, 70];
  if (maxAbs <= 1e-12) return `rgb(${neutral.join(',')})`;
  const t = Math.max(0, Math.min(1, Math.abs(d) / maxAbs));
  const target = d >= 0 ? pos : neg;
  const c = neutral.map((v, i) => Math.round(v + (target[i]! - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/**
 * The interaction term (discrete mixed partial): do an extra copy and an
 * extra draw compound, or overlap/substitute? Replaced a naive per-axis delta
 * toggle earlier in this project specifically because it answers "where's
 * the optimum" more directly than either axis alone (see PLAN.md/UI_DESIGN.md).
 */
function interactionAt(curves: Map<number, Float64Array | null>, k: number, n: number): number | null {
  if (n === 0) return null;
  const cur = curves.get(k), prev = curves.get(k - 1);
  if (!cur || !prev) return null;
  return (cur[n]! - cur[n - 1]!) - (prev[n]! - prev[n - 1]!);
}

const WINDOW = 12;

export function GridTab() {
  const { groups, deckSize, turnCfg } = useAppState();
  const { ast, error } = useQueryModelCtx();
  const [gridGroupId, setGridGroupId] = useState<string>(groups[0]?.id ?? '');
  const [maxDraws, setMaxDraws] = useState(20);
  const [mode, setMode] = useState<Mode>('value');

  const g: Group | undefined = groups.find((x) => x.id === gridGroupId) ?? groups[0];
  const hand = effectiveOpeningHand(turnCfg);
  const nMax = Math.min(deckSize, maxDraws);

  // Cheap, synchronous: the raw (non-mulligan) curve per swept row. evaluate()
  // itself is fast (a few ms at most) -- this was never the bottleneck.
  const rawComputed = useMemo(() => {
    if (!ast || !g) return null;
    const fixed = groups.filter((x) => x.id !== g.id).reduce((s, x) => s + x.count, 0);
    const kPossible = deckSize - fixed;
    // Centered sliding window on the ACTUAL count -- a fixed 0..12 range was a
    // real bug earlier in this project: at A=37 in a 99-card deck, the real
    // composition never even appeared in the visible window (see PLAN.md).
    let kLo = Math.max(0, g.count - Math.floor(WINDOW / 2));
    let kHi = Math.min(kPossible, kLo + WINDOW);
    kLo = Math.max(0, kHi - WINDOW);
    const computeFrom = Math.max(0, kLo - 1); // one extra row so dCopy/interaction never fake-NA at the edge

    const rows: Array<{ k: number; sizes: Sizes; dnf: Dnf | null; curve: Float64Array | null }> = [];
    for (let k = computeFrom; k <= kHi; k++) {
      const trialGroups = groups.map((x) => (x.id === g.id ? { ...x, count: k } : x));
      const sizes: Record<string, number> = {};
      for (const x of trialGroups) sizes[x.id] = x.count;
      try {
        const dnf = normalize(ast, sizes);
        const curve = evaluate(deckSize, sizes, dnf).curve;
        rows.push({ k, sizes, dnf, curve });
      } catch {
        rows.push({ k, sizes, dnf: null, curve: null });
      }
    }
    return { rows, kLo, kHi };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ast, g?.id, g?.count, groups, deckSize]);

  // Expensive part, off the main thread: one batched worker request for
  // every row's mulligan-adjusted curve, instead of a synchronous loop
  // calling optimalMulliganCurve once per row (confirmed directly as a
  // real cause of UI jank -- ~160ms for the default deck alone, scaling up
  // with deck/group complexity, and running regardless of which tab was
  // actually visible since this tab stays mounted).
  const workerRef = useRef<WorkerLike | null>(null);
  if (!workerRef.current) workerRef.current = getMulliganWorker();

  const batchRequest = useMemo<Omit<MulliganBatchRequest, 'id'> | null>(() => {
    if (turnCfg.mulligans <= 0 || !rawComputed) return null;
    const entries = rawComputed.rows
      .filter((r): r is { k: number; sizes: Sizes; dnf: Dnf; curve: Float64Array } => r.dnf !== null && r.curve !== null)
      .map((r) => ({ dnf: r.dnf, sizes: r.sizes }));
    if (entries.length === 0) return null;
    return { kind: 'batch', entries, deckSize, handSize: turnCfg.openingHand, maxMulligans: turnCfg.mulligans };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawComputed, deckSize, turnCfg]);

  const { data: mulliganBatchRaw, error: mulliganTooLarge } = useWorkerRequest<
    Omit<MulliganBatchRequest, 'id'>, MulliganBatchSuccess | MulliganFailure
  >(
    workerRef.current,
    batchRequest,
    (r) => (r.ok ? r.curves : null),
  );
  const mulliganBatch = mulliganBatchRaw as MulliganBatchSuccess['curves'] | null;

  if (error) return <p className="hint bad">{error}</p>;
  if (!g) return <p className="hint">Add a group first.</p>;
  if (!rawComputed) return null;
  if (hand > nMax) {
    return (
      <p className="hint flag">
        Starting hand size ({hand}) is past &quot;max cards drawn&quot; ({nMax}) &mdash; raise max draws to see any columns.
      </p>
    );
  }

  const { rows, kLo, kHi } = rawComputed;
  const curves = new Map<number, Float64Array | null>();
  rows.forEach((row, i) => {
    if (!row.curve) { curves.set(row.k, null); return; }
    if (turnCfg.mulligans > 0 && mulliganBatch && !mulliganTooLarge) {
      const mc = mulliganBatch[i];
      curves.set(row.k, mc ? buildDisplayCurve(row.curve, mc, turnCfg.openingHand) : row.curve);
    } else {
      curves.set(row.k, row.curve);
    }
  });

  const cols: number[] = [];
  for (let n = hand; n <= nMax; n++) cols.push(n);

  let maxAbsDiff = 0;
  if (mode === 'both') {
    for (let k = kLo; k <= kHi; k++) {
      for (const n of cols) {
        const d = interactionAt(curves, k, n);
        if (d !== null) maxAbsDiff = Math.max(maxAbsDiff, Math.abs(d));
      }
    }
  }

  return (
    <div>
      <div className="row-line">
        <label className="inline-field">
          <span>Vary copies of</span>
          <select value={gridGroupId} onChange={(e) => setGridGroupId(e.target.value)}>
            {groups.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
        <label className="inline-field">
          <span>Max drawn</span>
          <NumberInput
            type="number" min={1} max={60} value={maxDraws}
            onCommit={(n) => setMaxDraws(Math.max(1, n))}
          />
        </label>
        <div className="tab-strip" style={{ border: 'none', margin: 0, padding: 0 }}>
          <button className={mode === 'value' ? 'active' : ''} onClick={() => setMode('value')}>values</button>
          <button className={mode === 'both' ? 'active' : ''} onClick={() => setMode('both')}>&Delta; both (interaction)</button>
        </div>
      </div>

      <div className="table-scroll">
        <table className="heat-table">
          <thead>
            <tr>
              <th className="corner">copies &darr; / drawn &rarr;</th>
              {cols.map((n) => <th key={n}>{n}</th>)}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: kHi - kLo + 1 }, (_, i) => kLo + i).map((k) => (
              <tr key={k} className={k === g.count ? 'active-row' : ''}>
                <th>
                  {k}{k === g.count && <span style={{ color: colorFor(g.id) }}> &#9666;</span>}
                </th>
                {cols.map((n) => {
                  if (mode === 'value') {
                    const curve = curves.get(k);
                    if (!curve) return <td key={n} className="na">&mdash;</td>;
                    const p = curve[n]!;
                    return (
                      <td key={n} style={{ background: heat(p) }} title={`${k} copies, ${n} drawn: ${(p * 100).toFixed(2)}%`}>
                        {(p * 100).toFixed(0)}
                      </td>
                    );
                  }
                  const d = interactionAt(curves, k, n);
                  if (d === null) return <td key={n} className="na">&mdash;</td>;
                  return (
                    <td
                      key={n}
                      style={{ background: divHeat(d, maxAbsDiff) }}
                      title={`${k - 1}\u2192${k} copies \u00d7 ${n - 1}\u2192${n} drawn: ${d >= 0 ? '+' : '\u2212'}${(Math.abs(d) * 100).toFixed(2)}%`}
                    >
                      {(d * 100).toFixed(1)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">
        {mode === 'value'
          ? <>P (%) as <b>{g.name}</b> copies and cards drawn both vary. Row marked &#9666; is your current deck.</>
          : <>Interaction between an extra copy of <b>{g.name}</b> and an extra card drawn &mdash; positive (cool) means
            they compound, negative (warm) means they overlap/substitute.</>}
        {turnCfg.mulligans > 0 && !mulliganBatch && !mulliganTooLarge && (
          <span className="mulligan-loading"> Computing optimal-mulligan-adjusted values\u2026</span>
        )}
      </p>
      {mulliganTooLarge && (
        <p className="hint flag">
          Showing raw (non-mulligan) values &mdash; optimal-mulligan search was too large for this grid: {mulliganTooLarge}
        </p>
      )}
    </div>
  );
}
