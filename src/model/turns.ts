/**
 * Draw-count <-> turn mapping. PLAN.md §6.
 * Off-by-one here is the most dangerous bug in the app: it's silently wrong,
 * never throws, and every downstream number still looks plausible.
 */
export interface TurnConfig {
  /** Cards in the starting hand, before any turn's draw and before mulligans. */
  openingHand: number;
  /** Cards drawn per turn from turn 1 onward. */
  drawsPerTurn: number;
  /**
   * Whether turn 1 itself includes a draw. false = going first ("on the
   * play" in TCG jargon), which skips it — the more common default. true =
   * going second ("on the draw"). Named for the mechanical effect rather
   * than the jargon term; see UI_DESIGN.md §3 for why this was renamed from
   * `onThePlay` and why the polarity had to flip along with the name (a
   * checkbox literally labeled "first turn draw" has to read true when turn
   * 1 has one, not when it doesn't).
   */
  firstTurnDraw: boolean;
  /**
   * Number of London-style mulligans taken. APPROXIMATION: modeled as a
   * straight reduction of the effective opening hand (openingHand - mulligans),
   * i.e. as if you'd simply been dealt a smaller hand. The actual rule — draw
   * a fresh 7, then keep whichever (7-mulligans) cards you choose, bottoming
   * the rest — is a "best subset" optimization: you'd keep more copies of
   * your relevant cards than a same-size random hand would have, because you
   * get to pick. That's an order-statistic problem over which cards to keep,
   * and for a multi-group boolean query "best subset" isn't even well-defined
   * without knowing which combination you're optimizing for — so it's a real
   * math project, not a parameter tweak. This flat reduction is deliberately
   * the CONSERVATIVE direction: real mulligan hands are never worse than this
   * model says, only better. See PLAN.md for the exact model as a future item.
   */
  mulligans: number;
}

export const DEFAULT_TURN_CONFIG: TurnConfig = {
  openingHand: 7,
  drawsPerTurn: 1,
  firstTurnDraw: false,
  mulligans: 0,
};

/** openingHand after the (approximated) effect of mulligans, never negative. */
export function effectiveOpeningHand(cfg: TurnConfig): number {
  return Math.max(0, cfg.openingHand - cfg.mulligans);
}

/** Cards seen by the end of a given turn (turn 0 = opening hand only, before turn 1). */
export function cardsSeenByTurn(turn: number, cfg: TurnConfig): number {
  const hand = effectiveOpeningHand(cfg);
  if (turn <= 0) return hand;
  const draws = cfg.firstTurnDraw ? turn : turn - 1;
  return hand + Math.max(0, draws) * cfg.drawsPerTurn;
}

/**
 * Inverse: which turn does a given number of cards drawn (n) correspond to?
 * n below the effective opening hand has no turn yet (still assembling the
 * opener) -> null. Between turns (drawsPerTurn > 1) rounds down to the turn
 * in progress.
 */
export function turnForCardsSeen(n: number, cfg: TurnConfig): number | null {
  const hand = effectiveOpeningHand(cfg);
  if (n < hand) return null;
  if (cfg.drawsPerTurn <= 0) return 0;
  const draws = Math.floor((n - hand) / cfg.drawsPerTurn);
  return draws + (cfg.firstTurnDraw ? 0 : 1);
}
