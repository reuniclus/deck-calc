/**
 * Bridge between a structured "pick group / comparator / number" UI and the
 * Expr AST. Exists because the text query language, while total and tested,
 * still requires knowing precedence and quoting rules by hand — a picker
 * that can only ever emit valid Expr trees removes that whole failure class.
 * Free-text remains the escape hatch for anything that doesn't fit.
 *
 * Model: a query is a union of COMBOS (OR'd together). Each combo is a plain
 * AND of conditions. There is deliberately no per-combo "at least k of these"
 * threshold — that was the same idea as just adding more combos (an
 * "at least 2 of {A,B,C}" combo is exactly the OR of its three 2-subsets),
 * and it couldn't survive a text round-trip anyway once the text grammar
 * dropped its "any k of" keyword (see parse.ts) — so it's not offered here
 * either, to avoid a picker state that TEXT can't represent as the same
 * shape. One combo, pre-filled with every condition ANDed, is exactly what a
 * fresh query should look like — that's just the single-combo case below.
 */
import type { Expr, GroupId } from './expr';

export interface Row {
  g: GroupId;
  neg: boolean;
  lo: number;
  hi: number | null;
}

/** One combo: every row ANDed together. */
export interface Clause {
  rows: Row[];
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
  return { t: 'and', kids: c.rows.map(rowExpr) };
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
    const row = tryAtomOrNeg(e);
    if (!row) return null; // genuine nesting inside this AND — not flat
    rows.push(row);
  }
  return rows;
}

/** One combo's worth of Expr -> Clause, or null if it's not a flat shape. */
function clauseFromExpr(e: Expr): Clause | null {
  const single = tryAtomOrNeg(e);
  if (single) return { rows: [single] };
  if (e.t === 'and') {
    const rows = rowsFromAndKids(e.kids);
    return rows ? { rows } : null;
  }
  // atLeastK has no text spelling anymore and the builder has no way to
  // author one — if it somehow shows up (e.g. a query built before this
  // change), treat it like any other shape this picker can't represent.
  return null;
}

/**
 * Inverse of compileFlat, when possible. A top-level OR becomes several
 * combos; anything else (a bare atom, an AND) becomes a single combo.
 * Returns null for real nesting this shape doesn't cover (an OR inside an
 * AND, an OR nested inside another OR, a NOT of something other than a bare
 * atom, an atLeastK) — those queries still work fine as text.
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
