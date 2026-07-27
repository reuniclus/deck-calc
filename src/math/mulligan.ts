/**
 * Optimal mulligan strategy, computed exactly -- no simulation, no
 * approximation. Deliberately NOT real London-mulligan rules (where each
 * kept hand shrinks by one card per mulligan taken): every attempt draws a
 * fresh, FULL-SIZE hand from whatever remains of the deck, and a rejected
 * hand's specific cards go to the bottom (removed from consideration for
 * later attempts, effectively -- see the deck-size caveat below). This was
 * a deliberate simplification agreed on explicitly: use combos for things
 * that could reasonably appear in an opening hand, not full by-turn-T
 * combos, and accept the rule bend in exchange for a model that stays
 * simple and exact rather than exact-but-opaque.
 *
 * A small recursive branch-and-recurse: enumerate every possible opening-
 * hand composition (bounded, same stars-and-bars style cap as elsewhere in
 * this project -- a 7-card hand over a few tracked groups has a naturally
 * tiny number of distinct compositions), and for each, compare keeping it
 * against mulliganing (a fresh hand from the smaller remaining deck, with
 * one less mulligan available) -- V(state, mulligansLeft) = max over both
 * options, weighted by each hand's own EXACT multivariate-hypergeometric
 * probability. No card is ever "probably" drawn; every branch is one exact
 * probability, and a failed hand deterministically implies exactly which
 * smaller deck comes next.
 *
 * A real consequence worth naming: this is NOT equivalent to treating each
 * mulligan attempt as an independent fresh look with the same probability
 * every time (that would be the real London-rule reshuffling semantics,
 * which this deliberately isn't -- see above). A failing hand, by
 * definition, drew FEWER of what you needed than average, so the deck left
 * behind is enriched in it, making the next attempt genuinely easier than
 * an independent look would be. Confirmed directly: bestP here comes out
 * strictly higher than the naive 1-(1-p)^(mulligans+1) formula would give,
 * and that's correct, not a bug -- see mulligan.test.ts.
 *
 * Scope, deliberately: this recomputes the OPENING HAND point exactly.
 * Turns 1+ continue to draw from a single continuous shuffle as before --
 * modeling the mulligan's cascading effect on every LATER draw (not just
 * the opening hand) is a substantially bigger problem, out of scope here.
 */
import { evaluate } from './evaluate';
import type { Box, Dnf, GroupId, Interval, Sizes } from './expr';

export class MulliganTooLargeError extends Error {}

export interface HandStrategyRow {
  hand: Record<GroupId, number>;
  /** P(drawing exactly this hand from the full deck). */
  probability: number;
  /** P(success by turn T) if THIS hand is kept (no more mulligans used). */
  keepP: number;
  /** P(success by turn T) if this hand is mulliganed, playing optimally afterward. */
  mulliganP: number;
  shouldKeep: boolean;
}

export interface MulliganResult {
  /** Optimal P(success by turn T), mixing over every possible hand/mulligan sequence. */
  bestP: number;
  /** P(success by turn T) if you NEVER mulligan (always keep the first hand) -- for comparison. */
  neverMulliganP: number;
  /** Every possible FIRST opening hand, with its own keep-vs-mulligan verdict under optimal play. */
  strategy: HandStrategyRow[];
}

const MAX_LEAVES = 300_000;

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 0; i < k; i++) result = (result * (n - i)) / (i + 1);
  return result;
}

interface DeckState {
  /** Remaining count per TRACKED group only. */
  sizes: Sizes;
  deckSize: number;
}

/** Every feasible hand composition drawable from `state`, each with its
 * EXACT multivariate-hypergeometric probability. Untracked ("other") cards
 * fill whatever's left of the hand implicitly, same convention as the rest
 * of this app. */
function enumerateHands(
  groupIds: GroupId[],
  state: DeckState,
  handSize: number,
): Array<{ hand: Record<GroupId, number>; probability: number }> {
  const trackedTotal = groupIds.reduce((s, g) => s + (state.sizes[g] ?? 0), 0);
  const otherCount = state.deckSize - trackedTotal;
  const denom = choose(state.deckSize, handSize);
  const out: Array<{ hand: Record<GroupId, number>; probability: number }> = [];

  function recurse(idx: number, current: Record<GroupId, number>, remainingHand: number): void {
    if (idx === groupIds.length) {
      if (remainingHand > otherCount) return; // not enough "other" cards to fill the rest
      let numerator = choose(otherCount, remainingHand);
      for (const g of groupIds) numerator *= choose(state.sizes[g] ?? 0, current[g] ?? 0);
      const probability = denom > 0 ? numerator / denom : 0;
      if (probability > 0) out.push({ hand: { ...current }, probability });
      return;
    }
    const g = groupIds[idx]!;
    const maxTake = Math.min(state.sizes[g] ?? 0, remainingHand);
    for (let take = 0; take <= maxTake; take++) {
      recurse(idx + 1, { ...current, [g]: take }, remainingHand - take);
    }
  }
  recurse(0, {}, handSize);
  return out;
}

/** "You already have hand[g] of group g secured -- you now only need
 * (lo-hand[g]) MORE, capped at (hi-hand[g]) MORE." Returns null if the box
 * is already violated (hand[g] alone exceeds hi for some g): future draws
 * only ever ADD to a count, never remove, so an upper-bound violation from
 * the hand alone can never be undone by anything drawn afterward. */
function shiftBox(box: Box, hand: Record<GroupId, number>): Box | null {
  const shifted: Record<GroupId, Interval> = {};
  for (const g of Object.keys(box)) {
    const h = hand[g] ?? 0;
    const { lo, hi } = box[g]!;
    const newHi = hi - h;
    if (newHi < 0) return null;
    shifted[g] = { lo: Math.max(0, lo - h), hi: newHi };
  }
  return shifted;
}

function remainingSizes(state: DeckState, groupIds: GroupId[], hand: Record<GroupId, number>): Sizes {
  const out: Record<GroupId, number> = { ...state.sizes };
  for (const g of groupIds) out[g] = (state.sizes[g] ?? 0) - (hand[g] ?? 0);
  return out;
}

/** P(success by turn T) if `hand` is kept as-is (no more mulligans), given
 * `extraDraws` more cards get drawn from the remaining deck before turn T.
 * Reuses evaluate() directly on a shifted DNF over the SMALLER remaining
 * deck -- no re-parsing, no re-normalizing; evaluate()'s own existing
 * handling of an empty clause (already satisfied -> curve of 1s) and an
 * empty clause LIST (every clause violated -> curve of 0s) covers both
 * edge cases here for free. */
function keepValue(
  dnf: Dnf, groupIds: GroupId[], state: DeckState,
  hand: Record<GroupId, number>, handSize: number, extraDraws: number,
): number {
  const shiftedClauses = dnf.clauses
    .map((c) => shiftBox(c, hand))
    .filter((c): c is Box => c !== null);
  const shifted: Dnf = { clauses: shiftedClauses, monotone: dnf.monotone };
  const remSizes = remainingSizes(state, groupIds, hand);
  const remDeckSize = state.deckSize - handSize;
  const result = evaluate(remDeckSize, remSizes, shifted);
  return result.curve[Math.min(Math.max(0, extraDraws), remDeckSize)]!;
}

/** V(state, mulligansLeft): best achievable P(success by turn T) from a
 * fresh look at `state`, with `mulligansLeft` further mulligans available
 * after this one. */
function optimalValue(
  dnf: Dnf, groupIds: GroupId[], state: DeckState,
  handSize: number, extraDraws: number, mulligansLeft: number,
): number {
  const hands = enumerateHands(groupIds, state, handSize);
  let total = 0;
  for (const { hand, probability } of hands) {
    const keepP = keepValue(dnf, groupIds, state, hand, handSize, extraDraws);
    let best = keepP;
    if (mulligansLeft > 0) {
      const nextState: DeckState = {
        sizes: remainingSizes(state, groupIds, hand),
        deckSize: state.deckSize - handSize,
      };
      best = Math.max(best, optimalValue(dnf, groupIds, nextState, handSize, extraDraws, mulligansLeft - 1));
    }
    total += probability * best;
  }
  return total;
}

export function optimalMulliganStrategy(
  dnf: Dnf,
  fullSizes: Sizes,
  deckSize: number,
  handSize: number,
  extraDrawsForT: number,
  maxMulligans: number,
): MulliganResult {
  const groupIds = [...new Set(dnf.clauses.flatMap((c) => Object.keys(c)))];
  if (groupIds.length > 4) {
    throw new MulliganTooLargeError(`${groupIds.length} groups referenced -- capped at 4`);
  }
  // Loose (stars-and-bars, ignores individual group caps -- deliberately a
  // safe over-estimate) upper bound on the hand-space size per level, so an
  // oversized case fails immediately rather than grinding through a partial
  // recursion first.
  const handSpaceUpperBound = choose(handSize + groupIds.length, groupIds.length);
  const totalLeaves = Math.pow(handSpaceUpperBound, maxMulligans + 1);
  if (!Number.isFinite(totalLeaves) || totalLeaves > MAX_LEAVES) {
    throw new MulliganTooLargeError(
      `${groupIds.length} groups \u00d7 ${maxMulligans} mulligans -- search space too large`,
    );
  }

  const fullState: DeckState = { sizes: fullSizes, deckSize };
  const hands = enumerateHands(groupIds, fullState, handSize);

  const strategy: HandStrategyRow[] = [];
  let bestP = 0;
  let neverMulliganP = 0;
  for (const { hand, probability } of hands) {
    const keepP = keepValue(dnf, groupIds, fullState, hand, handSize, extraDrawsForT);
    let mulliganP = 0;
    if (maxMulligans > 0) {
      const nextState: DeckState = {
        sizes: remainingSizes(fullState, groupIds, hand),
        deckSize: deckSize - handSize,
      };
      mulliganP = optimalValue(dnf, groupIds, nextState, handSize, extraDrawsForT, maxMulligans - 1);
    }
    const shouldKeep = keepP >= mulliganP;
    strategy.push({ hand, probability, keepP, mulliganP, shouldKeep });
    bestP += probability * Math.max(keepP, mulliganP);
    neverMulliganP += probability * keepP;
  }

  return { bestP, neverMulliganP, strategy };
}
