/**
 * Bridge between a structured "pick group / comparator / number" UI and the
 * Expr AST. Exists because the text query language, while total and tested,
 * still requires knowing precedence, quoting rules, and `any k of (...)`
 * syntax by hand — a picker that can only ever emit valid Expr trees removes
 * that whole failure class for the shape below. Free-text remains the escape
 * hatch for anything that doesn't fit.
 *
 * Unified model: a query is a union of COMBOS (OR'd together). Each combo is
 * a list of conditions plus a threshold k — "at least k of these conditions
 * must hold." k defaults to the full row count, which IS an AND — so "all of
 * these," "any of these," and "at least N of these" are not three separate
 * shapes, they're the same one combo with different threshold values:
 *   - one combo, k = rows.length           -> old "all of these" (AND)
 *   - several 1-row combos, each k = 1      -> old "any of these" (OR)
 *   - one combo, k < rows.length            -> old "at least N of these"
 *   - several combos, some with k < rows.length -> the general case,
 *     e.g. (any 2 of A,B,C) | (D>=1)
 * A single combo pre-filled with k = rows.length (i.e. AND) is exactly what
 * a fresh query should look like, and it emerges from this model for free —
 * no special-casing needed to make "OR mode with AND preloaded" the default.
 */
import type { Expr, GroupId } from './expr';

export interface Row {
  g: GroupId;
  neg: boolean;
  lo: number;
  hi: number | null;
}

/** One combo: "at least k of these rows." k === rows.length means all of them (AND). */
export interface Clause {
  rows: Row[];
  k: number;
}

export interface FlatQuery {
  /** Combos, OR'd together. */
  clauses: Clause[];
}

function rowExpr(r: Row): Expr {
  const atom: Expr = { t: 'atom', g: r.g, lo: r.lo, hi: r.hi };
  return r.neg ? { t: 'not', kid: atom } : atom;
}

function clauseExpr(c: Clause): Expr {
  if (c.rows.length === 1) return rowExpr(c.rows[0]!);
  if (c.k >= c.rows.length) return { t: 'and', kids: c.rows.map(rowExpr) };
  return { t: 'atLeastK', k: c.k, kids: c.rows.map(rowExpr) };
}

export function compileFlat(fq: FlatQuery): Expr {
  // Drop any combo with no conditions rather than let it compile to an
  // always-true branch that would silently make the whole OR always true.
  const nonEmpty = fq.clauses.filter((c) => c.rows.length > 0);
  if (nonEmpty.length === 0) return { t: 'and', kids: [] }; // no conditions anywhere: unconstrained
  return { t: 'or', kids: nonEmpty.map(clauseExpr) };
}

function tryAtomOrNeg(e: Expr): Row | null {
  if (e.t === 'atom') return { g: e.g, neg: false, lo: e.lo, hi: e.hi };
  if (e.t === 'not' && e.kid.t === 'atom') {
    return { g: e.kid.g, neg: true, lo: e.kid.lo, hi: e.kid.hi };
  }
  return null;
}

/**
 * Like tryAtomOrNeg, but also recognizes a SINGLE kid that is itself an AND of
 * exactly two same-group atoms — printExpr's only spelling for one range
 * condition. Needed anywhere a condition is read as one standalone kid rather
 * than scanned for a sibling pair (atLeastK's kids are each independent; an
 * AND's kids are scanned together by rowsFromAndKids instead).
 */
function rowFromCondition(e: Expr): Row | null {
  const direct = tryAtomOrNeg(e);
  if (direct) return direct;
  if (e.t === 'and' && e.kids.length === 2) {
    const [x, y] = e.kids;
    if (x!.t === 'atom' && y!.t === 'atom' && x!.g === y!.g) {
      const his = [x!.hi, y!.hi].filter((h): h is number => h !== null);
      if (his.length > 0) {
        return { g: x!.g, neg: false, lo: Math.max(x!.lo, y!.lo), hi: Math.min(...his) };
      }
    }
  }
  return null;
}

/**
 * Turn the kids of an AND node into rows, folding any pair of plain atoms on
 * the SAME group into one range row — printExpr has no single-token spelling
 * for a range (lo>0 and hi<K), so it emits "G>=lo & G<=hi", and re-parsing
 * that yields exactly two atom kids on one group. Without this, touching a
 * range condition once through text would permanently kick a query out of
 * the builder. Works for any number of kids, not just a bare pair, since a
 * clause can mix a range condition alongside ordinary ones.
 */
function rowsFromAndKids(kids: readonly Expr[]): Row[] | null {
  const remaining = kids.slice();
  const rows: Row[] = [];
  while (remaining.length > 0) {
    const e = remaining.shift()!;
    if (e.t === 'atom') {
      const partnerIdx = remaining.findIndex((o) => o.t === 'atom' && o.g === e.g);
      if (partnerIdx !== -1) {
        const partner = remaining[partnerIdx] as Extract<Expr, { t: 'atom' }>;
        const his = [e.hi, partner.hi].filter((h): h is number => h !== null);
        if (his.length > 0) {
          remaining.splice(partnerIdx, 1);
          rows.push({ g: e.g, neg: false, lo: Math.max(e.lo, partner.lo), hi: Math.min(...his) });
          continue;
        }
      }
      rows.push({ g: e.g, neg: false, lo: e.lo, hi: e.hi });
      continue;
    }
    const row = rowFromCondition(e);
    if (!row) return null; // genuine nesting inside this AND — not flat
    rows.push(row);
  }
  return rows;
}

/** One combo's worth of Expr -> Clause, or null if it's not a flat shape. */
function clauseFromExpr(e: Expr): Clause | null {
  const single = tryAtomOrNeg(e);
  if (single) return { rows: [single], k: 1 };
  if (e.t === 'and') {
    const rows = rowsFromAndKids(e.kids);
    return rows ? { rows, k: rows.length } : null;
  }
  if (e.t === 'atLeastK') {
    const rows = e.kids.map(rowFromCondition);
    if (rows.some((r) => r === null)) return null;
    return { rows: rows as Row[], k: e.k };
  }
  return null;
}

/**
 * Inverse of compileFlat, when possible. A top-level OR becomes several
 * combos; anything else (a bare atom, an AND, an atLeastK) becomes a single
 * combo. Returns null for real nesting this shape doesn't cover (an OR
 * inside an AND, an OR nested inside another OR, a NOT of something other
 * than a bare atom) — those queries still work fine as text.
 */
export function decompileFlat(e: Expr): FlatQuery | null {
  if (e.t === 'or') {
    const clauses = e.kids.map(clauseFromExpr);
    if (clauses.some((c) => c === null)) return null;
    return { clauses: clauses as Clause[] };
  }
  const c = clauseFromExpr(e);
  return c ? { clauses: [c] } : null;
}
