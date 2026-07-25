/**
 * Draw-count <-> turn mapping. PLAN.md §6.
 * Off-by-one here is the most dangerous bug in the app: it's silently wrong,
 * never throws, and every downstream number still looks plausible.
 */
export interface TurnConfig {
  /** Cards in the starting hand, before any turn's draw. */
  openingHand: number;
  /** Cards drawn per turn from turn 1 onward. */
  drawsPerTurn: number;
  /** Player who goes first skips their turn-1 draw in most trading card games. */
  onThePlay: boolean;
}

export const DEFAULT_TURN_CONFIG: TurnConfig = {
  openingHand: 7,
  drawsPerTurn: 1,
  onThePlay: true,
};

/** Cards seen by the end of a given turn (turn 0 = opening hand only, before turn 1). */
export function cardsSeenByTurn(turn: number, cfg: TurnConfig): number {
  if (turn <= 0) return cfg.openingHand;
  const draws = cfg.onThePlay ? turn - 1 : turn;
  return cfg.openingHand + Math.max(0, draws) * cfg.drawsPerTurn;
}

/**
 * Inverse: which turn does a given number of cards drawn (n) correspond to?
 * n below the opening hand has no turn yet (still assembling the opener) -> null.
 * Between turns (drawsPerTurn > 1) rounds down to the turn in progress.
 */
export function turnForCardsSeen(n: number, cfg: TurnConfig): number | null {
  if (n < cfg.openingHand) return null;
  if (cfg.drawsPerTurn <= 0) return 0;
  const draws = Math.floor((n - cfg.openingHand) / cfg.drawsPerTurn);
  return draws + (cfg.onThePlay ? 1 : 0);
}
