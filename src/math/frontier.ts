/**
 * Monotone-only: minimal sufficient vectors (the Pareto/antichain frontier).
 * PLAN.md §4/§5.2/§5.3. NEVER call this on a non-monotone Dnf — an upper-bounded
 * box or a surviving NOT breaks the up-set assumption everything here relies on.
 */
import { boxCurve } from './boxdp';
import type { Box, GroupId } from './expr';

export class NotMonotoneError extends Error {}
export class UnreachableTargetError extends Error {}

export interface FrontierResult {
  /** Every minimal vector of per-group counts that reaches `target` at draw count n. */
  vectors: Array<Record<GroupId, number>>;
  /** Best achievable probability within the searched bounds, for context if unreachable. */
  bestP: number;
}

/**
 * For ONE up-set clause (a pure >= box) and a fixed draw count n, find every
 * minimal per-group count vector reaching `target`. Groups outside the clause
 * are held at their current size and folded into the deck's unconstrained pool.
 *
 * "Minimal" = no coordinate can be lowered without the vector dropping below
 * target. There is deliberately no single answer: these ARE the tradeoffs.
 *
 * Algorithm: greedy descent from the maximal corner. Every state that still
 * reaches the target spawns one child per coordinate that can be decremented;
 * a state with no such child is minimal. This explores only the boundary
 * region, not the full lattice, which is what makes it a staircase walk
 * rather than an O(volume) search.
 */
export function minimalVectors(
  clause: Box,
  n: number,
  N: number,
  target: number,
): FrontierResult {
  const groups = Object.keys(clause).sort();
  if (groups.length === 0) return { vectors: [], bestP: 1 }; // no constraint: already certain

  // Max plausible count per group: whatever's left after every OTHER constrained
  // group takes its minimum, capped by the deck itself AND by the caller's own
  // requested ceiling (clause[g].hi) — that ceiling is the sweep bound, not a
  // constraint on draws (draws always require >= lo; hi=K makes it a pure box).
  const maxPerGroup: Record<GroupId, number> = {};
  for (const g of groups) {
    const restMin = groups.filter((h) => h !== g).reduce((s, h) => s + clause[h]!.lo, 0);
    const deckLimited = Math.max(clause[g]!.lo, N - restMin);
    maxPerGroup[g] = Math.min(clause[g]!.hi, deckLimited);
  }

  const memo = new Map<string, boolean>();
  const key = (v: Record<GroupId, number>): string => groups.map((g) => v[g]).join(',');

  function reaches(v: Record<GroupId, number>): boolean {
    const k = key(v);
    const cached = memo.get(k);
    if (cached !== undefined) return cached;
    const kSum = groups.reduce((s, g) => s + v[g]!, 0);
    const ok = kSum <= N && boxCurve(N, groups.map((g) => ({ K: v[g]!, lo: clause[g]!.lo, hi: v[g]! })))[n]! >= target - 1e-12;
    memo.set(k, ok);
    return ok;
  }

  function pOf(v: Record<GroupId, number>): number {
    const kSum = groups.reduce((s, g) => s + v[g]!, 0);
    if (kSum > N) return 0;
    return boxCurve(N, groups.map((g) => ({ K: v[g]!, lo: clause[g]!.lo, hi: v[g]! })))[n]!;
  }

  const top: Record<GroupId, number> = {};
  for (const g of groups) top[g] = maxPerGroup[g]!;
  const bestP = pOf(top);

  if (!reaches(top)) return { vectors: [], bestP };

  const found: Array<Record<GroupId, number>> = [];
  const seenMinimal = new Set<string>();
  const visited = new Set<string>();
  const MAX_VISITED = 200_000;

  function descend(v: Record<GroupId, number>): void {
    const k = key(v);
    if (visited.has(k)) return;
    visited.add(k);
    if (visited.size > MAX_VISITED) {
      throw new RangeError(`minimalVectors: explored ${MAX_VISITED} states without terminating`);
    }

    let anyChild = false;
    for (const g of groups) {
      if (v[g]! <= clause[g]!.lo) continue;
      const child = { ...v, [g]: v[g]! - 1 };
      if (reaches(child)) { anyChild = true; descend(child); }
    }
    if (!anyChild && !seenMinimal.has(k)) {
      seenMinimal.add(k);
      found.push(v);
    }
  }

  descend(top);
  return { vectors: dedupeMinimal(found, groups), bestP };
}

function dedupeMinimal(
  found: Array<Record<GroupId, number>>,
  groups: GroupId[],
): Array<Record<GroupId, number>> {
  // Descent already yields minimal points, but different paths can reach the
  // same point or a point dominated by another minimal point found later.
  return found.filter((a, i) => !found.some((b, j) =>
    j !== i && groups.every((g) => b[g]! <= a[g]!) && groups.some((g) => b[g]! < a[g]!)));
}
