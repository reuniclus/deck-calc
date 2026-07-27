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
   * Number of mulligans to consider for the DEDICATED optimal-mulligan-
   * strategy analysis (see src/math/mulligan.ts) -- NOT a hand-size
   * reduction here. The old model approximated a mulligan as simply
   * "openingHand - mulligans," as if you'd been dealt a smaller hand
   * directly; that was wrong in a specific, checkable way (a mulliganed
   * hand is never worse than a same-size random hand, since you choose
   * which cards to bottom) and it never touched the main curve at all,
   * only a reference marker's position -- reported directly, see chat
   * history. The kept hand under mulligan.ts's model is ALWAYS full-size
   * (this codebase's agreed simplification: draw a fresh full hand each
   * attempt, bottom a whole rejected hand, rather than real London rules'
   * shrinking keep) -- so this field no longer changes `effectiveOpeningHand`
   * at all. It only feeds the separate optimal-strategy computation.
   */
  mulligans: number;
}

export const DEFAULT_TURN_CONFIG: TurnConfig = {
  openingHand: 7,
  drawsPerTurn: 1,
  firstTurnDraw: false,
  mulligans: 0,
};

/** The kept opening hand is always full-size -- mulligans no longer shrink
 * it (see the `mulligans` field's own comment). Kept for callers that used
 * to reach through this function; it's now just `cfg.openingHand`. */
export function effectiveOpeningHand(cfg: TurnConfig): number {
  return Math.max(0, cfg.openingHand);
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
