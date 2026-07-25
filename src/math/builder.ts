/**
 * Bridge between a structured "pick group / comparator / number" UI and the
 * Expr AST. Exists because the text query language, while total and tested,
 * still requires knowing precedence, quoting rules, and `any k of (...)`
 * syntax by hand — a picker that can only ever emit valid Expr trees removes
 * that whole failure class for the common shapes below. Free-text remains
 * the escape hatch for anything that doesn't fit.
 *
 * Three shapes are supported:
 *   'and'      — a single list of conditions, all required (A>=1 & B>=1)
 *   'atLeastK' — k of a list of conditions (any 2 of A>=1, B>=1, C>=1)
 *   'or'       — a union of COMBOS, each combo itself an AND of conditions:
 *                (A>1 & B>2) | (C>1) | ... — this is what makes "multiple
 *                combos" (several distinct card combinations, any one of
 *                which is a win) expressible without dropping to text.
 */
import type { Expr, GroupId } from './expr';

export interface Row {
  g: GroupId;
  neg: boolean;
  lo: number;
  hi: number | null;
}

/** One AND'd-together combo inside an 'or' query. */
export interface Clause {
  rows: Row[];
}

export type Mode = 'and' | 'or' | 'atLeastK';

export interface FlatQuery {
  mode: Mode;
  /** Used by 'and' and 'atLeastK'. Empty for 'or'. */
  rows: Row[];
  /** Used by 'or' — each entry is one combo, ANDed internally, ORed together. Empty otherwise. */
  clauses: Clause[];
  /** Only meaningful when mode is 'atLeastK'. */
  k: number;
}

function rowExpr(r: Row): Expr {
  const atom: Expr = { t: 'atom', g: r.g, lo: r.lo, hi: r.hi };
  return r.neg ? { t: 'not', kid: atom } : atom;
}

function clauseExpr(c: Clause): Expr {
  if (c.rows.length === 1) return rowExpr(c.rows[0]!);
  return { t: 'and', kids: c.rows.map(rowExpr) };
}

export function compileFlat(fq: FlatQuery): Expr {
  if (fq.mode === 'and') return { t: 'and', kids: fq.rows.map(rowExpr) };
  if (fq.mode === 'atLeastK') return { t: 'atLeastK', k: fq.k, kids: fq.rows.map(rowExpr) };
  // 'or': drop any combo with no conditions rather than let it compile to an
  // always-true branch that would silently make the whole OR always true.
  const nonEmpty = fq.clauses.filter((c) => c.rows.length > 0);
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

/**
 * Inverse of compileFlat, when possible. Returns null for anything with real
 * nesting this shape doesn't cover (an OR inside an AND, a NOT of something
 * other than a bare atom, etc.) — those queries still work fine as text.
 */
export function decompileFlat(e: Expr): FlatQuery | null {
  const empty = { rows: [], clauses: [], k: 1 };

  // The whole expression might itself be a single condition.
  const single = tryAtomOrNeg(e);
  if (single) return { mode: 'and', ...empty, rows: [single] };

  if (e.t === 'and') {
    const rows = rowsFromAndKids(e.kids);
    return rows ? { mode: 'and', ...empty, rows } : null;
  }
  if (e.t === 'atLeastK') {
    const rows = e.kids.map(rowFromCondition);
    if (rows.some((r) => r === null)) return null;
    return { mode: 'atLeastK', ...empty, rows: rows as Row[], k: e.k };
  }
  if (e.t === 'or') {
    const clauses: Clause[] = [];
    for (const kid of e.kids) {
      if (kid.t === 'and') {
        const rows = rowsFromAndKids(kid.kids);
        if (!rows) return null;
        clauses.push({ rows });
      } else {
        const row = rowFromCondition(kid);
        if (!row) return null;
        clauses.push({ rows: [row] });
      }
    }
    return { mode: 'or', ...empty, clauses };
  }
  return null;
}
