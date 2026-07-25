/**
 * Inverse of parseQuery. Exists so queries can be STORED against group ids and
 * RENDERED with whatever the group is currently called — renaming a group must
 * not invalidate a query. PLAN.md §8.
 */
import type { Expr, GroupId } from './expr';

const KEYWORDS = new Set(['and', 'or', 'not', 'any', 'atleast', 'of', 'true', 'false']);
const BARE = /^[A-Za-z_][A-Za-z0-9_\-]*$/;

/** Quote a group name if it would otherwise lex as something else. */
export function quoteName(name: string): string {
  if (BARE.test(name) && !KEYWORDS.has(name.toLowerCase())) return name;
  return name.includes('"') ? `'${name.replace(/'/g, '')}'` : `"${name}"`;
}

const OR = 1, AND = 2, UNARY = 3;

export function printExpr(e: Expr, nameOf: (g: GroupId) => string): string {
  return go(e, OR);

  function go(x: Expr, parent: number): string {
    switch (x.t) {
      case 'atom': {
        const n = quoteName(nameOf(x.g));
        if (x.hi === null) return `${n}>=${x.lo}`;
        if (x.lo === x.hi) return `${n}=${x.lo}`;
        if (x.lo === 0) return `${n}<=${x.hi}`;
        return wrap(`${n}>=${x.lo} & ${n}<=${x.hi}`, AND, parent);
      }
      case 'not': return `!${go(x.kid, UNARY)}`;
      case 'and':
        if (x.kids.length === 0) return 'true';
        if (x.kids.length === 1) return go(x.kids[0]!, parent);
        return wrap(x.kids.map((k) => go(k, AND)).join(' & '), AND, parent);
      case 'or':
        if (x.kids.length === 0) return 'false';
        if (x.kids.length === 1) return go(x.kids[0]!, parent);
        return wrap(x.kids.map((k) => go(k, OR)).join(' | '), OR, parent);
      case 'atLeastK':
        // Self-delimiting, so it never needs outer parentheses.
        return `any ${x.k} of (${x.kids.map((k) => go(k, OR)).join(', ')})`;
    }
  }
}

function wrap(s: string, own: number, parent: number): string {
  return parent > own ? `(${s})` : s;
}
