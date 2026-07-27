import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useAppState, type Group } from './AppState';
import { parseQuery, ParseError } from '../math/parse';
import { normalize } from '../math/normalize';
import { evaluate } from '../math/evaluate';
import { analyze } from '../math/analyze';
import { decompileFlat } from '../math/builder';
import { QueryTooLargeError, UnknownGroupError, type Sizes, type Expr } from '../math/expr';

export function sizesOf(groups: Group[]): Sizes {
  const s: Record<string, number> = {};
  for (const g of groups) s[g.id] = g.count;
  return s;
}

export function resolverFor(groups: Group[]) {
  return (name: string): string | null =>
    groups.find((g) => g.name.trim().toLowerCase() === name.trim().toLowerCase())?.id ?? null;
}

export function nameOfFactory(groups: Group[]) {
  return (id: string): string => groups.find((g) => g.id === id)?.name ?? '?';
}

export function describeError(e: unknown): string {
  if (e instanceof ParseError) return `Parse error at ${e.pos}: ${e.message}`;
  if (e instanceof UnknownGroupError) return e.message;
  if (e instanceof QueryTooLargeError) return `Query too large: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

export interface QueryModel {
  sizes: Sizes;
  /** Set only when parsing/evaluation failed; every other field is null in that case. */
  error: string | null;
  /** Exposed so panels needing to re-evaluate at DIFFERENT counts (Grid, Suggestions)
   * don't have to re-parse the text themselves. Never mutated; treat as read-only. */
  ast: Expr | null;
  dnf: ReturnType<typeof normalize> | null;
  result: ReturnType<typeof evaluate> | null;
  analysis: ReturnType<typeof analyze> | null;
  /** null = not representable by the flat builder (real nesting) -> fall back to text. */
  flat: ReturnType<typeof decompileFlat> | null;
}

/** Everything that does NOT depend on target: parse, normalize, the actual
 * DP (evaluate), decompileFlat. This is the expensive part -- re-running it
 * just because target changed was pure waste, since nothing here reads
 * target at all. Only analyze() (a cheap linear scan of an already-computed
 * curve) needs it. */
type BaseModel = Omit<QueryModel, 'analysis'>;

function computeBaseModel(query: string, groups: Group[], deckSize: number): BaseModel {
  const sizes = sizesOf(groups);
  try {
    const ast = parseQuery(query, resolverFor(groups));
    const dnf = normalize(ast, sizes);
    const result = evaluate(deckSize, sizes, dnf);
    const flat = decompileFlat(ast);
    return { sizes, error: null, ast, dnf, result, flat };
  } catch (e) {
    return { sizes, error: describeError(e), ast: null, dnf: null, result: null, flat: null };
  }
}

const QueryModelCtx = createContext<QueryModel | null>(null);

/** Computes the pipeline ONCE per relevant state change; every consumer reads
 * the same result via useQueryModelCtx() instead of each re-running parse/
 * normalize/evaluate/analyze independently (useMemo does not share cache
 * across separate call sites/components). Nested memos: the expensive base
 * (parse/normalize/evaluate) only re-runs on query/groups/deckSize; target
 * changes only re-run the cheap analyze() step on top of it. */
export function QueryModelProvider({ children }: { children: ReactNode }) {
  const { query, groups, deckSize, target } = useAppState();
  const base = useMemo(() => computeBaseModel(query, groups, deckSize), [query, groups, deckSize]);
  const model = useMemo<QueryModel>(() => {
    if (base.error || !base.result) return { ...base, analysis: null };
    return { ...base, analysis: analyze(base.result.curve, target, base.result.monotone) };
  }, [base, target]);
  return <QueryModelCtx.Provider value={model}>{children}</QueryModelCtx.Provider>;
}

export function useQueryModelCtx(): QueryModel {
  const ctx = useContext(QueryModelCtx);
  if (!ctx) throw new Error('useQueryModelCtx must be used within QueryModelProvider');
  return ctx;
}
