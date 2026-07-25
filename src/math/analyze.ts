import type { Curve } from './boxdp';

export interface Analysis {
  curve: Curve;
  /** deltas[n] = P(n+1) - P(n): the value of drawing one more card. PLAN.md §5.1. */
  deltas: Float64Array;
  /** Draw count whose next card buys the most probability — the diminishing-returns knee. */
  knee: number;
  argmaxP: number;
  maxP: number;
  monotone: boolean;
  target: number;
  /** Smallest n reaching the target, or null. Meaningful as "the" answer only if monotone. */
  drawsNeeded: number | null;
  /**
   * Inclusive n-ranges where P >= target. Monotone queries yield at most one, open to the right.
   * Non-monotone queries can yield a bounded window, which is the honest answer. PLAN.md §4.
   */
  windows: Array<[number, number]>;
}

export function analyze(curve: Curve, target: number, monotone: boolean): Analysis {
  const N = curve.length - 1;
  const deltas = new Float64Array(Math.max(0, N));
  for (let n = 0; n < N; n++) deltas[n] = curve[n + 1]! - curve[n]!;

  let knee = 0;
  for (let n = 1; n < deltas.length; n++) if (deltas[n]! > deltas[knee]!) knee = n;

  let argmaxP = 0;
  for (let n = 1; n <= N; n++) if (curve[n]! > curve[argmaxP]!) argmaxP = n;

  const windows: Array<[number, number]> = [];
  let start: number | null = null;
  for (let n = 0; n <= N; n++) {
    const ok = curve[n]! >= target - 1e-12;
    if (ok && start === null) start = n;
    if (!ok && start !== null) { windows.push([start, n - 1]); start = null; }
  }
  if (start !== null) windows.push([start, N]);

  return {
    curve,
    deltas,
    knee,
    argmaxP,
    maxP: curve[argmaxP]!,
    monotone,
    target,
    drawsNeeded: windows.length > 0 ? windows[0]![0] : null,
    windows,
  };
}
