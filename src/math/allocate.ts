/**
 * Deck-slot allocation. PLAN.md §5.2/§5.3.
 *
 * Every extra copy of a combo group displaces an `others` card, so this is a
 * genuine constrained optimization over a fixed budget — not just "more is
 * better." Two dual questions:
 *   maximize P(...)          s.t. sum(K_g) <= budget   -> allocate()
 *   minimize sum(K_g - base) s.t. P(...) >= target      -> minSlotsForTarget()
 */
import { boxCurve } from './boxdp';
import type { Box, GroupId } from './expr';

export interface AllocateResult {
  /** Best split of the budget across groups found. */
  best: Record<GroupId, number>;
  bestP: number;
  /** true only when every composition was actually tried (m small). */
  exact: boolean;
}

const EXACT_GROUP_LIMIT = 3; // C(budget+m-1, m-1) enumeration; m=4 needs a worker (PLAN.md §5.2)

function pOf(clause: Box, counts: Record<GroupId, number>, groups: GroupId[], N: number, n: number): number {
  const kSum = groups.reduce((s, g) => s + counts[g]!, 0);
  if (kSum > N) return 0;
  return boxCurve(N, groups.map((g) => ({ K: counts[g]!, lo: clause[g]!.lo, hi: counts[g]! })))[n]!;
}

/** All compositions of `budget` into groups.length non-negative parts, each within [0, cap]. */
function* compositions(groups: readonly GroupId[], budget: number, caps: Record<GroupId, number>):
  Generator<Record<GroupId, number>> {
  function* rec(i: number, remaining: number, acc: Record<GroupId, number>):
    Generator<Record<GroupId, number>> {
    if (i === groups.length - 1) {
      const g = groups[i]!;
      if (remaining <= caps[g]!) yield { ...acc, [g]: remaining };
      return;
    }
    const g = groups[i]!;
    const cap = Math.min(caps[g]!, remaining);
    for (let c = 0; c <= cap; c++) yield* rec(i + 1, remaining - c, { ...acc, [g]: c });
  }
  yield* rec(0, budget, {});
}

/**
 * maximize P(clause) at draw count n, spending exactly `budget` slots across
 * `clause`'s groups (each starting from clause[g].lo, since fewer makes the
 * event impossible anyway). Exact for m<=3 groups; greedy hill-climb above that
 * — labeled explicitly, never silently presented as exact (PLAN.md §5.2).
 */
export function allocate(
  clause: Box,
  n: number,
  N: number,
  budget: number,
): AllocateResult {
  const groups = Object.keys(clause).sort();
  if (groups.length === 0) return { best: {}, bestP: 1, exact: true };

  const caps: Record<GroupId, number> = {};
  for (const g of groups) caps[g] = Math.min(N, clause[g]!.hi);

  if (groups.length <= EXACT_GROUP_LIMIT) {
    let best: Record<GroupId, number> | null = null;
    let bestP = -1;
    for (const v of compositions(groups, budget, caps)) {
      if (groups.some((g) => v[g]! < clause[g]!.lo)) continue; // below lo: contributes nothing
      const p = pOf(clause, v, groups, N, n);
      if (p > bestP) { bestP = p; best = v; }
    }
    if (!best) return { best: fallback(groups, clause, budget), bestP: 0, exact: true };
    return { best, bestP, exact: true };
  }

  return greedyAllocate(clause, groups, n, N, budget, caps);
}

function fallback(groups: GroupId[], clause: Box, budget: number): Record<GroupId, number> {
  // No composition met every group's `lo`; put everything toward the first group.
  const v: Record<GroupId, number> = {};
  let remaining = budget;
  for (const g of groups) { v[g] = Math.min(remaining, clause[g]!.lo); remaining -= v[g]!; }
  return v;
}

/** Greedy hill-climb: repeatedly move one slot from the weakest group to the strongest marginal gainer. */
function greedyAllocate(
  clause: Box, groups: GroupId[], n: number, N: number, budget: number, caps: Record<GroupId, number>,
): AllocateResult {
  const v: Record<GroupId, number> = {};
  for (const g of groups) v[g] = Math.min(clause[g]!.lo, caps[g]!);
  let spent = groups.reduce((s, g) => s + v[g]!, 0);

  // Spend the remaining budget one slot at a time on whichever group gains the most.
  while (spent < budget) {
    let bestGain = -Infinity, bestG: GroupId | null = null, baseP = pOf(clause, v, groups, N, n);
    for (const g of groups) {
      if (v[g]! >= caps[g]!) continue;
      const trial = { ...v, [g]: v[g]! + 1 };
      const gain = pOf(clause, trial, groups, N, n) - baseP;
      if (gain > bestGain) { bestGain = gain; bestG = g; }
    }
    if (!bestG) break; // every group is at its cap
    v[bestG] = v[bestG]! + 1;
    spent++;
  }
  return { best: v, bestP: pOf(clause, v, groups, N, n), exact: false };
}

export interface MinSlotsResult {
  /** Fewest total slots (beyond each group's own lo) needed to reach target, or null if unreachable within caps. */
  extraSlots: number | null;
  best: Record<GroupId, number> | null;
  bestP: number;
}

/**
 * Dual of allocate(): smallest total budget such that some split reaches `target`.
 * Scans budgets upward and reuses allocate() at each — cheap because boxCurve
 * memoizes nothing here but each call is a handful of DP passes at worst.
 */
export function minSlotsForTarget(
  clause: Box,
  n: number,
  N: number,
  target: number,
): MinSlotsResult {
  const groups = Object.keys(clause);
  if (groups.length === 0) return { extraSlots: 0, best: {}, bestP: 1 };

  const baseline = groups.reduce((s, g) => s + clause[g]!.lo, 0);
  const capTotal = groups.reduce((s, g) => s + Math.min(N, clause[g]!.hi), 0);

  for (let budget = baseline; budget <= capTotal; budget++) {
    const r = allocate(clause, n, N, budget);
    if (r.bestP >= target - 1e-12) return { extraSlots: budget - baseline, best: r.best, bestP: r.bestP };
  }
  const top = allocate(clause, n, N, capTotal);
  return { extraSlots: null, best: top.best, bestP: top.bestP };
}
