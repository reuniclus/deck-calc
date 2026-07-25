/**
 * Tiny query language, so the harness (and later the URL/advanced mode) can accept text.
 *   Athletes>=2 & Spells>=1
 *   (A>=1 | B>=1) & !C=0
 *   any 2 of (A>=1, B>=1, C>=2)
 *   "Blue Mana">=2 & !Dead
 * Bare `A` means `A>=1`. Operators: >= <= = == > < ; & | ! and parentheses.
 */
import { type Expr, type GroupId } from './expr';

export class ParseError extends Error {
  constructor(message: string, readonly pos: number) { super(message); }
}

type Tok =
  | { k: 'id'; v: string; i: number; quoted?: boolean }
  | { k: 'num'; v: number; i: number }
  | { k: 'op'; v: '>=' | '<=' | '=' | '>' | '<'; i: number }
  | { k: '&' | '|' | '!' | '(' | ')' | ','; i: number };

const WORD_OPS: Record<string, '&' | '|'> = { and: '&', or: '|' };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')' || c === ',') { out.push({ k: c, i }); i++; continue; }
    if (c === '&' || c === '|') { out.push({ k: c, i }); i += src[i + 1] === c ? 2 : 1; continue; }
    if (c === '!' || c === '~') { out.push({ k: '!', i }); i++; continue; }
    if (c === '>' || c === '<') {
      const two = src[i + 1] === '=';
      out.push({ k: 'op', v: two ? (c === '>' ? '>=' : '<=') : c, i });
      i += two ? 2 : 1;
      continue;
    }
    if (c === '=') { out.push({ k: 'op', v: '=', i }); i += src[i + 1] === '=' ? 2 : 1; continue; }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      out.push({ k: 'num', v: Number(src.slice(i, j)), i });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      // Quoted names let groups contain spaces without colliding with keywords.
      const j = src.indexOf(c, i + 1);
      if (j < 0) throw new ParseError('unterminated quoted name', i);
      out.push({ k: 'id', v: src.slice(i + 1, j), i, quoted: true });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_\-]/.test(src[j]!)) j++;
      const raw = src.slice(i, j);
      const lower = raw.toLowerCase();
      const wordOp = WORD_OPS[lower];
      if (wordOp) { out.push({ k: wordOp, i }); i += raw.length; continue; }
      if (lower === 'not') { out.push({ k: '!', i }); i += raw.length; continue; }
      out.push({ k: 'id', v: raw, i });
      i += raw.length;
      continue;
    }
    throw new ParseError(`unexpected character "${c}"`, i);
  }
  return out;
}

/**
 * `resolve` maps a typed name to a GroupId (case-insensitive lookup lives in the caller,
 * because the math layer must not know about UI naming rules).
 */
export function parseQuery(src: string, resolve: (name: string) => GroupId | null): Expr {
  const toks = lex(src);
  let p = 0;

  const peek = (): Tok | undefined => toks[p];
  const at = (k: Tok['k']): boolean => toks[p]?.k === k;
  const pos = (): number => toks[p]?.i ?? src.length;

  function expect(k: Tok['k']): Tok {
    const t = toks[p];
    if (!t || t.k !== k) throw new ParseError(`expected ${k}`, pos());
    p++;
    return t;
  }

  function parseOr(): Expr {
    const kids = [parseAnd()];
    while (at('|')) { p++; kids.push(parseAnd()); }
    return kids.length === 1 ? kids[0]! : { t: 'or', kids };
  }

  function parseAnd(): Expr {
    const kids = [parseUnary()];
    while (at('&')) { p++; kids.push(parseUnary()); }
    return kids.length === 1 ? kids[0]! : { t: 'and', kids };
  }

  function parseUnary(): Expr {
    if (at('!')) { p++; return { t: 'not', kid: parseUnary() }; }
    return parsePrimary();
  }

  function parsePrimary(): Expr {
    if (at('(')) { p++; const e = parseOr(); expect(')'); return e; }
    const t = peek();
    if (!t) throw new ParseError('unexpected end of query', src.length);

    if (t.k === 'id') {
      const word = t.v.toLowerCase();
      if (!t.quoted && (word === 'any' || word === 'atleast')) return parseAtLeastK();
      p++;
      const gid = resolve(t.v);
      if (!gid) throw new ParseError(`unknown group "${t.v}"`, t.i);
      if (at('op')) {
        const op = (toks[p] as Extract<Tok, { k: 'op' }>).v;
        p++;
        const n = expect('num') as Extract<Tok, { k: 'num' }>;
        switch (op) {
          case '>=': return { t: 'atom', g: gid, lo: n.v, hi: null };
          case '>': return { t: 'atom', g: gid, lo: n.v + 1, hi: null };
          case '<=': return { t: 'atom', g: gid, lo: 0, hi: n.v };
          case '<': return { t: 'atom', g: gid, lo: 0, hi: n.v - 1 };
          case '=': return { t: 'atom', g: gid, lo: n.v, hi: n.v };
        }
      }
      return { t: 'atom', g: gid, lo: 1, hi: null }; // bare name = at least one
    }
    throw new ParseError('expected a group name or "("', t.i);
  }

  function parseAtLeastK(): Expr {
    p++; // any | atleast
    const n = expect('num') as Extract<Tok, { k: 'num' }>;
    const of = peek();
    if (of?.k === 'id' && of.v.toLowerCase() === 'of') p++;
    expect('(');
    const kids = [parseOr()];
    while (at(',')) { p++; kids.push(parseOr()); }
    expect(')');
    return { t: 'atLeastK', k: n.v, kids };
  }

  if (toks.length === 0) throw new ParseError('empty query', 0);
  const e = parseOr();
  if (p < toks.length) throw new ParseError('unexpected trailing input', pos());
  return e;
}
