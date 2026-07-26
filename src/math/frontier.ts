/**
 * Monotone-only: minimal sufficient vectors (the Pareto/antichain frontier).
 * PLAN.md §4/§5.2/§5.3. NEVER call this on a non-monotone Dnf — an upper-bounded
 * box or a surviving NOT breaks the up-set assumption everything here relies on.
 */
import { boxCurve } from './boxdp';
import { allocate } from './allocate';
import type { Box, GroupId } from './expr';

export class NotMonotoneError extends Error {}
export class UnreachableTargetError extends Error {}

export interface FrontierResult {
  /** Every minimal vector of per-group counts that reaches `target` at draw count n. */
  vectors: Array<Record<GroupId, number>>;
  /** Best achievable probability within the searched bounds, for context if unreachable. */
  bestP: number;
}

const OUTER_CAP = 20_000; // total prefix combinations explored across any fixed (non-staircased) groups

/**
 * For ONE up-set clause (a pure >= box) and a fixed draw count n, find every
 * minimal per-group count vector reaching `target`. "Minimal" = no coordinate
 * can be lowered without the vector dropping below target. There is
 * deliberately no single answer: these ARE the tradeoffs.
 *
 * IMPORTANT: with a total-deck budget (kSum <= N) cutting across the search
 * box, no single "maximal corner" dominates the whole feasible region —
 * (K_a=20,K_b=5) and (K_a=5,K_b=20) can both be feasible at N=25 with
 * neither dominating the other. An earlier version descended from one
 * corner and missed this entirely (see PLAN.md). The correct approach is a
 * genuine staircase walk over the last two free coordinates — O(range), not
 * O(range^2) — with any additional groups fixed via a bounded outer loop.
 */
export function minimalVectors(
  clause: Box,
  n: number,
  N: number,
  target: number,
): FrontierResult {
  const groups = Object.keys(clause).sort();
  if (groups.length === 0) return { vectors: [], bestP: 1 }; // no constraint: already certain

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

  // The true best achievable P over this box+budget IS the deck-slot
  // allocation problem allocate.ts already solves correctly (spend the
  // entire deck, budget=N) — reuse it rather than re-deriving it here.
  // Checking only "one group maxed, rest at their minimum" corners is NOT
  // sufficient: the optimum is often a BALANCE (e.g. two groups at 20/20
  // beats either group at 39/1), which only a real solver finds.
  const { bestP } = allocate(clause, n, N, N);

  // Each group's own physical ceiling: the caller's requested hi, capped by
  // whatever's left after every OTHER group takes its minimum.
  const ownMax: Record<GroupId, number> = {};
  for (const g of groups) {
    const restMin = groups.filter((h) => h !== g).reduce((s, h) => s + clause[h]!.lo, 0);
    ownMax[g] = Math.min(clause[g]!.hi, Math.max(clause[g]!.lo, N - restMin));
  }

  const found: Array<Record<GroupId, number>> = [];

  /**
   * Exact 2D staircase over `gx`,`gy`, everything else fixed at `base`.
   * Classic monotone-boundary walk: as x increases, the smallest reaching y
   * only ever decreases (P is monotone in both), so a single decreasing
   * pointer sweep finds every minimal (x,y) pair in O(range_x + range_y).
   *
   * The budget (kSum <= N) must be reclamped every step, not just seeded
   * once — otherwise once x grows enough to make the CURRENT y infeasible,
   * `reaches` fails for a reason that has nothing to do with the target,
   * and the shrink loop (which stops at the first failure) gets stuck
   * reporting a stale, budget-violating y forever.
   */
  function staircase2D(gx: GroupId, gy: GroupId, base: Record<GroupId, number>): void {
    const otherSum = Object.values(base).reduce((s, v) => s + v, 0);
    const budgetForPair = N - otherSum;
    const loX = clause[gx]!.lo, loY = clause[gy]!.lo;
    const hiX = Math.min(ownMax[gx]!, budgetForPair - loY);
    const at = (x: number, y: number): Record<GroupId, number> => ({ ...base, [gx]: x, [gy]: y });

    let y = Math.min(ownMax[gy]!, budgetForPair - loX);
    let lastY = Infinity;
    for (let x = loX; x <= hiX; x++) {
      y = Math.min(y, budgetForPair - x); // shrink for budget BEFORE trying to shrink for target
      while (y > loY && reaches(at(x, y - 1))) y--;
      if (reaches(at(x, y)) && y < lastY) {
        found.push(at(x, y));
        lastY = y;
      }
      // else: even at this row's most generous (budget-respecting) y, target
      // isn't reached for this x — nothing to record, but larger x may work.
    }
  }

  // Fix every group except the last two via a bounded outer loop, then hand
  // off to the exact staircase for the remaining pair. m<=2 has no prefix at all.
  const prefixGroups = groups.slice(0, -2);
  const [gx, gy] = groups.slice(-2) as [GroupId, GroupId];

  if (groups.length === 1) {
    const g = groups[0]!;
    let lo = clause[g]!.lo, hi = ownMax[g]!;
    // smallest K in [lo,hi] that reaches target, via the same decreasing-pointer idea in 1D
    let v = hi;
    while (v > lo && reaches({ [g]: v - 1 })) v--;
    if (reaches({ [g]: v })) found.push({ [g]: v });
  } else if (prefixGroups.length === 0) {
    staircase2D(gx, gy, {});
  } else {
    let outerCount = 0;
    const recurse = (idx: number, base: Record<GroupId, number>): void => {
      if (idx === prefixGroups.length) { staircase2D(gx, gy, base); return; }
      const g = prefixGroups[idx]!;
      for (let v = clause[g]!.lo; v <= ownMax[g]!; v++) {
        outerCount++;
        if (outerCount > OUTER_CAP) {
          throw new RangeError(`minimalVectors: prefix search exceeded ${OUTER_CAP} combinations`);
        }
        recurse(idx + 1, { ...base, [g]: v });
      }
    };
    recurse(0, {});
  }

  return { vectors: dedupeMinimal(found, groups), bestP };
}

function dedupeMinimal(
  found: Array<Record<GroupId, number>>,
  groups: GroupId[],
): Array<Record<GroupId, number>> {
  // The staircase (and each outer-loop prefix) already yields locally minimal
  // points, but different prefixes can produce points that dominate each other.
  const seen = new Map<string, Record<GroupId, number>>();
  for (const v of found) seen.set(groups.map((g) => v[g]).join(','), v);
  const uniq = [...seen.values()];
  return uniq.filter((a, i) => !uniq.some((b, j) =>
    j !== i && groups.every((g) => b[g]! <= a[g]!) && groups.some((g) => b[g]! < a[g]!)));
}
