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
import type { Curve } from './boxdp';
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

// Pre-memoization this capped total PATHS (handSpaceSize^(mulligans+1)),
// which was a severe overestimate of real cost -- checkSizeCap's formula
// now reflects the actual memoized work, so this can be far more generous
// than before while still meaning roughly the same thing: also raised
// because the computation now runs through a Web Worker (see
// mulliganWorker.ts), so a multi-second case no longer freezes the page --
// it's an acceptable wait with a visible loading state, not a hard failure
// mode to avoid at all costs.
const MAX_LEAVES = 1_000_000;

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
/** Cache key for memoizing optimalValue/optimalCurveRec: a state is fully
 * characterized by the remaining count per tracked group PLUS mulligans
 * left -- NOT by which specific sequence of hands got there. Removal is
 * just addition, and addition is commutative, so different hand sequences
 * routinely land on the identical state (e.g. drawing {2,1} then {1,0}
 * removes the same total as {1,0} then {2,1}). Confirmed as the actual
 * redundancy behind the reported slowness, not assumed. */
function stateKey(groupIds: GroupId[], sizes: Sizes, mulligansLeft: number): string {
  return groupIds.map((g) => sizes[g] ?? 0).join(',') + '|' + mulligansLeft;
}

function optimalValue(
  dnf: Dnf, groupIds: GroupId[], state: DeckState,
  handSize: number, extraDraws: number, mulligansLeft: number,
  cache: Map<string, number>,
): number {
  const key = stateKey(groupIds, state.sizes, mulligansLeft);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

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
      best = Math.max(best, optimalValue(dnf, groupIds, nextState, handSize, extraDraws, mulligansLeft - 1, cache));
    }
    total += probability * best;
  }
  cache.set(key, total);
  return total;
}

/** Whole-curve version of keepValue: same shifted-DNF-on-the-smaller-deck
 * trick, but returns evaluate()'s FULL curve (indexed by extraDraws, i.e.
 * additional cards drawn after this hand) instead of one point from it.
 * evaluate() computes the whole curve internally regardless -- the scalar
 * version was simply discarding everything except one index. */
function keepCurve(
  dnf: Dnf, groupIds: GroupId[], state: DeckState,
  hand: Record<GroupId, number>, handSize: number,
): Curve {
  const shiftedClauses = dnf.clauses
    .map((c) => shiftBox(c, hand))
    .filter((c): c is Box => c !== null);
  const shifted: Dnf = { clauses: shiftedClauses, monotone: dnf.monotone };
  const remSizes = remainingSizes(state, groupIds, hand);
  const remDeckSize = state.deckSize - handSize;
  return evaluate(remDeckSize, remSizes, shifted).curve;
}

/** Pointwise max of two curves over the SAME "extraDraws" axis, even though
 * they have different lengths (a curve after one more mulligan is shorter,
 * since that branch's remaining deck is smaller by one more handSize) --
 * `shorter`'s value is held at its last (maximum-n) entry for any index
 * beyond its own length, matching the scalar version's Math.min(extraDraws,
 * remDeckSize) clamp, just applied pointwise across a whole array now. */
function pointwiseMaxExtend(longer: Curve, shorter: Curve): Curve {
  const out = new Float64Array(longer.length);
  const lastShorter = shorter[shorter.length - 1]!;
  for (let i = 0; i < longer.length; i++) {
    const shortVal = i < shorter.length ? shorter[i]! : lastShorter;
    out[i] = Math.max(longer[i]!, shortVal);
  }
  return out;
}

/** Whole-curve version of optimalValue: V(state, mulligansLeft) as a
 * function of extraDraws, not just at one fixed value. */
function optimalCurveRec(
  dnf: Dnf, groupIds: GroupId[], state: DeckState,
  handSize: number, mulligansLeft: number,
  cache: Map<string, Curve>,
): Curve {
  const key = stateKey(groupIds, state.sizes, mulligansLeft);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const hands = enumerateHands(groupIds, state, handSize);
  const remDeckSize = state.deckSize - handSize;
  const total = new Float64Array(remDeckSize + 1);
  for (const { hand, probability } of hands) {
    const kc = keepCurve(dnf, groupIds, state, hand, handSize);
    let best = kc;
    if (mulligansLeft > 0) {
      const nextState: DeckState = {
        sizes: remainingSizes(state, groupIds, hand),
        deckSize: state.deckSize - handSize,
      };
      const mc = optimalCurveRec(dnf, groupIds, nextState, handSize, mulligansLeft - 1, cache);
      best = pointwiseMaxExtend(kc, mc);
    }
    for (let i = 0; i < total.length; i++) total[i]! += probability * best[i]!;
  }
  cache.set(key, total);
  return total;
}

export interface MulliganCurveResult {
  /** Indexed by extraDraws (cards drawn AFTER the kept hand), NOT total
   * cards seen -- callers displaying by total draw count need to shift by
   * handSize themselves (see useMulliganStrategy.tsx). */
  bestCurve: Curve;
  neverMulliganCurve: Curve;
}

/** Same exact model as optimalMulliganStrategy, generalized to return the
 * WHOLE curve (every extraDraws value at once) rather than one point --
 * lets the chart/table/grid show the mulligan-adjusted success rate
 * everywhere, not just at one specific goal turn. Reuses every helper
 * (enumerateHands, shiftBox, the size-cap check) unchanged; the recursion
 * is the same shape, just carrying arrays instead of scalars. */
export function optimalMulliganCurve(
  dnf: Dnf,
  fullSizes: Sizes,
  deckSize: number,
  handSize: number,
  maxMulligans: number,
): MulliganCurveResult {
  const groupIds = [...new Set(dnf.clauses.flatMap((c) => Object.keys(c)))];
  checkSizeCap(groupIds, handSize, maxMulligans);

  const fullState: DeckState = { sizes: fullSizes, deckSize };
  const hands = enumerateHands(groupIds, fullState, handSize);
  const remDeckSize = deckSize - handSize;
  const bestCurve = new Float64Array(remDeckSize + 1);
  const neverMulliganCurve = new Float64Array(remDeckSize + 1);
  const cache = new Map<string, Curve>();

  for (const { hand, probability } of hands) {
    const kc = keepCurve(dnf, groupIds, fullState, hand, handSize);
    let best = kc;
    if (maxMulligans > 0) {
      const nextState: DeckState = {
        sizes: remainingSizes(fullState, groupIds, hand),
        deckSize: deckSize - handSize,
      };
      const mc = optimalCurveRec(dnf, groupIds, nextState, handSize, maxMulligans - 1, cache);
      best = pointwiseMaxExtend(kc, mc);
    }
    for (let i = 0; i <= remDeckSize; i++) {
      bestCurve[i]! += probability * best[i]!;
      neverMulliganCurve[i]! += probability * kc[i]!;
    }
  }

  return { bestCurve, neverMulliganCurve };
}

/** Shared by both optimalMulliganStrategy and optimalMulliganCurve: same
 * loose (stars-and-bars, ignores individual group caps -- deliberately a
 * safe over-estimate) upper bound on the hand-space size per level, so an
 * oversized case fails immediately rather than grinding through a partial
 * recursion first. */
function checkSizeCap(groupIds: GroupId[], handSize: number, maxMulligans: number): void {
  if (groupIds.length > 4) {
    throw new MulliganTooLargeError(`${groupIds.length} groups referenced -- capped at 4`);
  }
  const G = groupIds.length;
  const handSpaceUpperBound = choose(handSize + G, G);
  // Pre-memoization this was handSpaceUpperBound^(maxMulligans+1) -- the
  // total PATH count. With memoization the real cost is (hand enumeration
  // per state) * (number of DISTINCT states across all mulligan-depth
  // levels), and the number of distinct states at depth m (cumulative
  // removal after m draws) is bounded by choose(handSize*m + G, G) --
  // loose/safe (ignores individual group caps), but a SUM across levels
  // instead of a PRODUCT, which is the actual change memoization made.
  // Confirmed directly: the old formula rejected a 3-group/2-mulligan case
  // that the memoized version completes in well under the old 2-group time.
  let totalStates = 0;
  for (let m = 0; m <= maxMulligans; m++) totalStates += choose(handSize * m + G, G);
  const totalWork = handSpaceUpperBound * totalStates;
  if (!Number.isFinite(totalWork) || totalWork > MAX_LEAVES) {
    throw new MulliganTooLargeError(
      `${groupIds.length} groups \u00d7 ${maxMulligans} mulligans -- search space too large`,
    );
  }
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
  checkSizeCap(groupIds, handSize, maxMulligans);

  const fullState: DeckState = { sizes: fullSizes, deckSize };
  const hands = enumerateHands(groupIds, fullState, handSize);
  const cache = new Map<string, number>();

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
      mulliganP = optimalValue(dnf, groupIds, nextState, handSize, extraDrawsForT, maxMulligans - 1, cache);
    }
    const shouldKeep = keepP >= mulliganP;
    strategy.push({ hand, probability, keepP, mulliganP, shouldKeep });
    bestP += probability * Math.max(keepP, mulliganP);
    neverMulliganP += probability * keepP;
  }

  return { bestP, neverMulliganP, strategy };
}
