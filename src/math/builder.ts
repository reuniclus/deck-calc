/**
 * Bridge between a structured "pick group / comparator / number" UI and the
 * Expr AST. Exists because the text query language, while total and tested,
 * still requires knowing precedence, quoting rules, and `any k of (...)`
 * syntax by hand — a picker that can only ever emit valid Expr trees removes
 * that whole failure class for the common case (a flat list of conditions
 * joined by one operator). Free-text remains the escape hatch for anything
 * that doesn't fit this shape.
 */
import type { Expr, GroupId } from './expr';

export interface Row {
  g: GroupId;
  neg: boolean;
  lo: number;
  hi: number | null;
}

export type Mode = 'and' | 'or' | 'atLeastK';

export interface FlatQuery {
  mode: Mode;
  /** Only meaningful when mode is 'atLeastK'. */
  k: number;
  rows: Row[];
}

export function compileFlat(fq: FlatQuery): Expr {
  const kids: Expr[] = fq.rows.map((r) => {
    const atom: Expr = { t: 'atom', g: r.g, lo: r.lo, hi: r.hi };
    return r.neg ? { t: 'not', kid: atom } : atom;
  });
  if (fq.mode === 'and') return { t: 'and', kids };
  if (fq.mode === 'or') return { t: 'or', kids };
  return { t: 'atLeastK', k: fq.k, kids };
}

function asRow(e: Expr): Row | null {
  if (e.t === 'atom') return { g: e.g, neg: false, lo: e.lo, hi: e.hi };
  if (e.t === 'not' && e.kid.t === 'atom') {
    return { g: e.kid.g, neg: true, lo: e.kid.lo, hi: e.kid.hi };
  }
  // printExpr has no single-token spelling for a range atom (lo>0 and hi<K), so
  // it emits "G>=lo & G<=hi" — two atoms on the same group. Recognize that shape
  // and fold it back into one range row, or a range row round-trips as "too
  // complex" the moment it touches text once. See builder.test.ts.
  if (e.t === 'and' && e.kids.length === 2) {
    const [x, y] = e.kids;
    if (x!.t === 'atom' && y!.t === 'atom' && x!.g === y!.g) {
      const lo = Math.max(x!.lo, y!.lo);
      const hiCandidates = [x!.hi, y!.hi].filter((h): h is number => h !== null);
      if (hiCandidates.length > 0) {
        return { g: x!.g, neg: false, lo, hi: Math.min(...hiCandidates) };
      }
    }
  }
  return null;
}

/**
 * Inverse of compileFlat, when possible. Returns null for anything with real
 * nesting (an AND inside an OR, a NOT of something other than a bare atom,
 * etc.) — those queries still work fine as text, they just aren't flat.
 */
export function decompileFlat(e: Expr): FlatQuery | null {
  // The whole expression might itself BE a single row — a bare atom, a negated
  // atom, or (once it's round-tripped through text) an AND of two same-group
  // atoms standing in for one range. Try that before assuming e's top-level
  // kids are separate conditions.
  const single = asRow(e);
  if (single) return { mode: 'and', k: 1, rows: [single] };

  if (e.t === 'and' || e.t === 'or') {
    const rows = e.kids.map(asRow);
    if (rows.some((r) => r === null)) return null;
    return { mode: e.t, k: rows.length, rows: rows as Row[] };
  }
  if (e.t === 'atLeastK') {
    const rows = e.kids.map(asRow);
    if (rows.some((r) => r === null)) return null;
    return { mode: 'atLeastK', k: e.k, rows: rows as Row[] };
  }
  return null;
}
