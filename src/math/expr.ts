/** Query AST + box/DNF types. PLAN.md §3.4. */

export type GroupId = string;

/** hi === null means "unbounded above", resolved to the group's size at normalize time. */
export type Expr =
  | { t: 'atom'; g: GroupId; lo: number; hi: number | null }
  | { t: 'and'; kids: Expr[] }
  | { t: 'or'; kids: Expr[] }
  | { t: 'not'; kid: Expr }
  | { t: 'atLeastK'; k: number; kids: Expr[] };

/** An empty AND is vacuously satisfied; an empty OR is unsatisfiable. */
export const TRUE: Expr = { t: 'and', kids: [] };
export const FALSE: Expr = { t: 'or', kids: [] };

export const atLeast = (g: GroupId, k: number): Expr => ({ t: 'atom', g, lo: k, hi: null });
export const atMost = (g: GroupId, k: number): Expr => ({ t: 'atom', g, lo: 0, hi: k });
export const exactly = (g: GroupId, k: number): Expr => ({ t: 'atom', g, lo: k, hi: k });
export const inRange = (g: GroupId, lo: number, hi: number): Expr => ({ t: 'atom', g, lo, hi });
export const and = (...kids: Expr[]): Expr => ({ t: 'and', kids });
export const or = (...kids: Expr[]): Expr => ({ t: 'or', kids });
export const not = (kid: Expr): Expr => ({ t: 'not', kid });
export const atLeastKOf = (k: number, ...kids: Expr[]): Expr => ({ t: 'atLeastK', k, kids });

export interface Interval { readonly lo: number; readonly hi: number }

/** A conjunction of interval constraints — one per mentioned group. Absent group = unconstrained. */
export type Box = Readonly<Record<GroupId, Interval>>;

/** Group sizes, i.e. copies in the deck. */
export type Sizes = Readonly<Record<GroupId, number>>;

export interface Dnf {
  /** Union of boxes. Empty list = never true. A single empty box = always true. */
  readonly clauses: readonly Box[];
  /**
   * True iff the event is an up-set: every constrained group is bounded above only
   * by its own size. Frontier/staircase code is valid ONLY when this holds. PLAN.md §4.
   */
  readonly monotone: boolean;
}

export class QueryTooLargeError extends Error {}
export class UnknownGroupError extends Error {}

export function boxKey(b: Box): string {
  return Object.keys(b).sort().map((g) => `${g}:${b[g]!.lo}-${b[g]!.hi}`).join(',');
}

/** Intersection of two boxes, or null if the result is empty. */
export function intersect(a: Box, b: Box): Box | null {
  const out: Record<GroupId, Interval> = { ...a };
  for (const g of Object.keys(b)) {
    const bi = b[g]!;
    const ai = out[g];
    const lo = ai ? Math.max(ai.lo, bi.lo) : bi.lo;
    const hi = ai ? Math.min(ai.hi, bi.hi) : bi.hi;
    if (lo > hi) return null;
    out[g] = { lo, hi };
  }
  return out;
}

/** Is every draw satisfying `a` also satisfying `b`? Used to drop redundant clauses. */
export function subsumes(b: Box, a: Box, sizes: Sizes): boolean {
  for (const g of Object.keys(b)) {
    const bi = b[g]!;
    const ai = a[g] ?? { lo: 0, hi: sizes[g] ?? 0 };
    if (ai.lo < bi.lo || ai.hi > bi.hi) return false;
  }
  return true;
}
