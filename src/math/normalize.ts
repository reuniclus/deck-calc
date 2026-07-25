import { binom } from './lnfact';
import {
  type Box, type Dnf, type Expr, type GroupId, type Interval, type Sizes,
  QueryTooLargeError, UnknownGroupError, boxKey, intersect, subsumes,
} from './expr';

export const MAX_CLAUSES = 512;
const MAX_COMBINATIONS = 4096;

/** Expr -> DNF of boxes. PLAN.md §3.4/§3.5. */
export function normalize(expr: Expr, sizes: Sizes): Dnf {
  const expanded = expandAtLeastK(expr);
  const positive = pushNots(expanded, false, sizes);
  const raw = toDnf(positive);
  const clauses = prune(raw, sizes);
  return { clauses, monotone: clauses.every((b) => isUpSet(b, sizes)) };
}

/** "any k of these" -> OR over k-subsets. Costs C(c,k) clauses, so it is capped. */
function expandAtLeastK(e: Expr): Expr {
  switch (e.t) {
    case 'atom': return e;
    case 'not': return { t: 'not', kid: expandAtLeastK(e.kid) };
    case 'and': case 'or': return { t: e.t, kids: e.kids.map(expandAtLeastK) };
    case 'atLeastK': {
      const kids = e.kids.map(expandAtLeastK);
      const c = kids.length;
      if (e.k <= 0) return { t: 'and', kids: [] };
      if (e.k > c) return { t: 'or', kids: [] };
      if (e.k === 1) return { t: 'or', kids };
      if (e.k === c) return { t: 'and', kids };
      // Count BEFORE enumerating: C(40,20) is 1.4e11 and materializing it kills the tab.
      const count = binom(c, e.k);
      if (count > MAX_COMBINATIONS) {
        throw new QueryTooLargeError(
          `"any ${e.k} of ${c}" expands to ${count.toExponential(2)} terms; cap is ${MAX_COMBINATIONS}`);
      }
      const combos = choose(c, e.k);
      return { t: 'or', kids: combos.map((idx) => ({ t: 'and', kids: idx.map((i) => kids[i]!) })) };
    }
  }
}

function choose(n: number, k: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  (function rec(start: number): void {
    if (cur.length === k) { out.push([...cur]); return; }
    for (let i = start; i < n; i++) { cur.push(i); rec(i + 1); cur.pop(); }
  })(0);
  return out;
}

/**
 * De Morgan downward; NOT is eliminated at the atoms by complementing the interval,
 * which is why every boolean query reduces to a union of boxes.
 */
function pushNots(e: Expr, neg: boolean, sizes: Sizes): Expr {
  switch (e.t) {
    case 'not': return pushNots(e.kid, !neg, sizes);
    case 'and': return { t: neg ? 'or' : 'and', kids: e.kids.map((k) => pushNots(k, neg, sizes)) };
    case 'or': return { t: neg ? 'and' : 'or', kids: e.kids.map((k) => pushNots(k, neg, sizes)) };
    case 'atLeastK': throw new Error('pushNots: atLeastK must be expanded first');
    case 'atom': {
      const K = sizes[e.g];
      if (K === undefined) throw new UnknownGroupError(`unknown group "${e.g}"`);
      const lo = Math.max(0, e.lo);
      const hi = Math.min(e.hi ?? K, K);
      if (!neg) {
        if (lo > hi) return { t: 'or', kids: [] };           // impossible
        if (lo === 0 && hi === K) return { t: 'and', kids: [] }; // no constraint
        return { t: 'atom', g: e.g, lo, hi };
      }
      // complement of [lo,hi] within [0,K] is at most two intervals
      const parts: Expr[] = [];
      if (lo > hi) return { t: 'and', kids: [] };            // negation of impossible
      if (lo > 0) parts.push({ t: 'atom', g: e.g, lo: 0, hi: lo - 1 });
      if (hi < K) parts.push({ t: 'atom', g: e.g, lo: hi + 1, hi: K });
      return { t: 'or', kids: parts };
    }
  }
}

/** Distribute AND over OR. Input must be NOT-free and atLeastK-free. */
function toDnf(e: Expr): Box[] {
  switch (e.t) {
    case 'atom': {
      // pushNots resolves every hi to a concrete bound before we get here.
      if (e.hi === null) throw new Error('toDnf: unresolved upper bound');
      return [{ [e.g]: { lo: e.lo, hi: e.hi } }];
    }
    case 'or': return e.kids.flatMap(toDnf);
    case 'and': {
      let acc: Box[] = [{}];
      for (const kid of e.kids) {
        const next: Box[] = [];
        for (const a of acc) {
          for (const b of toDnf(kid)) {
            const m = intersect(a, b);
            if (m) next.push(m);
          }
        }
        if (next.length > MAX_CLAUSES) {
          throw new QueryTooLargeError(`query expands past ${MAX_CLAUSES} clauses`);
        }
        acc = next;
        if (acc.length === 0) return []; // contradiction
      }
      return acc;
    }
    default: throw new Error(`toDnf: unexpected node ${(e as Expr).t}`);
  }
}

/** Drop duplicates and clauses fully contained in another clause of the union. */
function prune(clauses: Box[], sizes: Sizes): Box[] {
  const byKey = new Map<string, Box>();
  for (const b of clauses) {
    const tightened = tighten(b, sizes);
    if (tightened === null) continue;
    if (Object.keys(tightened).length === 0) return [{}]; // union is certain
    byKey.set(boxKey(tightened), tightened);
  }
  // Duplicates are already gone, so mutual subsumption is impossible here.
  const uniq = [...byKey.values()];
  return uniq.filter((a, i) => !uniq.some((b, j) => j !== i && subsumes(b, a, sizes)));
}

/** Clamp to each group's real size and drop constraints that rule nothing out. */
function tighten(b: Box, sizes: Sizes): Box | null {
  const out: Record<GroupId, Interval> = {};
  for (const g of Object.keys(b)) {
    const K = sizes[g];
    if (K === undefined) throw new UnknownGroupError(`unknown group "${g}"`);
    const lo = Math.max(0, b[g]!.lo);
    const hi = Math.min(b[g]!.hi, K);
    if (lo > hi) return null;
    if (lo === 0 && hi === K) continue;
    out[g] = { lo, hi };
  }
  return out;
}

function isUpSet(b: Box, sizes: Sizes): boolean {
  return Object.keys(b).every((g) => b[g]!.hi === (sizes[g] ?? 0));
}
