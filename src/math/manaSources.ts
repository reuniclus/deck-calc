/**
 * Mana source requirements: "how many sources of a colour do I need to cast this
 * on time?" -- the Karsten question, computed exactly.
 *
 * Stage 1 of the manabase spec in `docs/manabase-spec.md`, which is AUTHORITATIVE
 * over any implementation. Only the pieces the spec marks "retain as-is" are ported
 * here (`cardsSeen`, `minSources`); the rest of stage 1, and stages 2-3, are not
 * implemented yet. The spec's Delta section lists known errors in its own reference
 * code -- read it before porting more.
 *
 * Reuses `sfAtLeast` from `hyper.ts` rather than duplicating a hypergeometric layer:
 * the spec's `hypergeomAtLeast` is the same function, and one of them is enough.
 *
 * ANCHOR, from the spec and non-negotiable: `minSources(99, cardsSeen(EDH, 4), 1,
 * 0.90) === 18`. That is the familiar EDH figure, and it is specific to multiplayer
 * where everyone draws on turn one, so `seen(4) = 11`. In 1v1 Commander the starting
 * player skips that draw, `seen(4) = 10`, and the answer becomes 19 -- which is why
 * `drawsOnFirstTurn` is a config field and 18 must never be hard-coded.
 */
import { sfAtLeast } from './hyper';

export interface DeckConfig {
  deckSize: number;
  openingHand: number;
  /** True for EDH multiplayer; false for the player on the play in 1v1. */
  drawsOnFirstTurn: boolean;
  /** Single scalar. The spec is explicit that there is no per-colour variant. */
  confidence: number;
}

export const EDH: DeckConfig = {
  deckSize: 99, openingHand: 7, drawsOnFirstTurn: true, confidence: 0.9,
};
export const SIXTY: DeckConfig = {
  deckSize: 60, openingHand: 7, drawsOnFirstTurn: false, confidence: 0.9,
};
export const LIMITED: DeckConfig = {
  deckSize: 40, openingHand: 7, drawsOnFirstTurn: false, confidence: 0.9,
};

/** Cards seen by turn `T`, capped at the deck. */
export function cardsSeen(cfg: DeckConfig, T: number): number {
  const drawn = cfg.drawsOnFirstTurn ? T : T - 1;
  return Math.min(cfg.deckSize, cfg.openingHand + Math.max(0, drawn));
}

/**
 * Fewest sources `K` such that P(at least `k` of them among `n` cards seen) >= `q`.
 * `Infinity` when unreachable even with the whole deck.
 *
 * Binary search is licensed by monotonicity in `K`, which the spec calls out
 * explicitly -- the probability of seeing enough sources cannot fall as sources are
 * added.
 */
export function minSources(N: number, n: number, k: number, q: number): number {
  if (k <= 0) return 0;
  if (k > n) return Infinity;
  if (sfAtLeast(N, N, n, k) < q) return Infinity;
  let lo = k;
  let hi = N;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (sfAtLeast(N, mid, n, k) >= q) hi = mid; else lo = mid + 1;
  }
  return lo;
}

export interface SourceRow {
  /** Pips of this colour in the cost. */
  k: number;
  /** Turn the card must be castable by. */
  turn: number;
  seen: number;
  /** Sources needed, or Infinity if unreachable. */
  sources: number;
}

/**
 * Sources needed across a grid of (pips, turn), which is what a UI wants: the whole
 * table at once rather than one cell per interaction.
 */
export function sourceTable(
  cfg: DeckConfig, pipCounts: number[], turns: number[],
): SourceRow[] {
  const out: SourceRow[] = [];
  for (const k of pipCounts) {
    for (const turn of turns) {
      const seen = cardsSeen(cfg, turn);
      out.push({ k, turn, seen, sources: minSources(cfg.deckSize, seen, k, cfg.confidence) });
    }
  }
  return out;
}
