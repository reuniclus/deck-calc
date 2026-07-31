/**
 * Card-selection effects (draw X / scry X / impulse X) as ORDINARY tracked
 * groups in the deck -- the model the main curve computation can use
 * unconditionally, with zero copies contributing nothing rather than taking a
 * different code path (PLAN.md, correction 1 of the cantrips-into-the-deck-
 * builder scoping). No dilution machinery here on purpose (correction 2): a
 * real tracked group has a real count, and `others` is derived as always.
 *
 * Effect taxonomy, settled 2026-07-30 -- the axes are mechanical, not a
 * taste-based grouping of card names:
 *
 * | effect            | examined | keepMax | kept costs a draw | non-kept leaves pool |
 * |-------------------|----------|---------|-------------------|----------------------|
 * | draw X            | X        | X (all) | no (goes to hand) | --                   |
 * | scry/preordain X  | X        | inf     | YES (sits on top) | yes (bottomed)       |
 * | impulse/surveil X | X        | 1       | no (hand/exile)   | yes (exiled/milled)  |
 * | ponder/portent X  | X        | inf     | yes               | NO + shuffle option  |
 *
 * "Bottomed" and "exiled" and "milled" are one fact for a query about what
 * you draw: gone from the reachable pool. That collapse is why the table has
 * four columns instead of a row per card name.
 *
 * Exactness scope: an effect that "looks at X and keeps the useful ones" is
 * modeled as examining X cards. For an up-set (all-`>=`) query that is exact.
 * For a query with an upper bound ("exactly 1 A"), real scrying can BURY a
 * card that would break the bound, so examining-X is a lower bound on the
 * true value -- allowed, with the error direction stated, rather than refused
 * (settled decision; see PLAN.md).
 *
 * Cascading (a look revealing another selection card, which then triggers) is
 * NOT modeled, same scope as before. Real values are somewhat higher.
 */
import { evaluate } from './evaluate';
import type { Curve } from './boxdp';
import type { Dnf, GroupId, Sizes } from './expr';

export interface SelectionEffect {
  /** The tracked group these copies live in. */
  group: GroupId;
  /** Extra cards examined per drawn copy. */
  examined: number;
  /** Most cards this effect can commit out of its window (Infinity = all). */
  keepMax: number;
  /** Kept cards sit on top of the library, so collecting them spends draws. */
  keptCostsDraw: boolean;
  /** Non-kept cards leave the reachable pool (bottomed/exiled/milled). */
  nonKeptLeavesPool: boolean;
  /** Ponder/Portent: the whole window can be shuffled back instead of kept.
   * The option IS the effect's value (see the reorder/shuffle note below). */
  canShuffle?: boolean;
  /** May a drawn copy be DECLINED rather than resolved? Casting is optional in
   * real play, and with an upper bound that matters: you would simply not cast
   * a generic draw spell that can only force bricks into your hand, while still
   * casting a copy that is itself a combo piece.
   *
   * Defaults to false (always resolves), which is what the brute force plays and
   * therefore what the exactness checks compare against. With it true the DP
   * takes max(resolve, decline) -- decided BEFORE the window is revealed, since
   * that is when the choice is really made -- and the value can only go up.
   *
   * For a monotone query the two agree exactly: resolving is never a mistake
   * when every card is welcome. */
  optionalResolve?: boolean;
}

export const drawEffect = (group: GroupId, x: number): SelectionEffect => ({
  group, examined: x, keepMax: x, keptCostsDraw: false, nonKeptLeavesPool: true,
});
export const scryEffect = (group: GroupId, x: number): SelectionEffect => ({
  group, examined: x, keepMax: Infinity, keptCostsDraw: true, nonKeptLeavesPool: true,
});
export const impulseEffect = (group: GroupId, x: number): SelectionEffect => ({
  group, examined: x, keepMax: 1, keptCostsDraw: false, nonKeptLeavesPool: true,
});

export const ponderEffect = (group: GroupId, x: number): SelectionEffect => ({
  group, examined: x, keepMax: Infinity, keptCostsDraw: true, nonKeptLeavesPool: false,
  canShuffle: true,
});

export class UnsupportedSelectionError extends Error {}

/** Only the draw-shaped effect is implemented so far (see PLAN.md's staging:
 * scry's kept-costs-a-draw, then impulse's keepMax, then ponder's shuffle
 * option, each gated on its own brute-force case). Anything else throws
 * rather than being silently approximated by the draw path -- the whole
 * finding that got us here is that plausible-looking approximations here are
 * wrong by single-digit percentage points with an effect-dependent sign. */
export function assertDrawShaped(effect: SelectionEffect): void {
  if (effect.keptCostsDraw || effect.keepMax < effect.examined) {
    throw new UnsupportedSelectionError(
      'only draw-shaped effects (whole window kept, no draw cost) are implemented',
    );
  }
}

/**
 * EXACT model for a "draw X" effect (everything examined goes to hand).
 *
 * The structural fact that makes this cheap, found by comparing both closed
 * forms against bruteSelection.ts per-k (see PLAN.md): the query's own group
 * composition is conditionally hypergeometric GIVEN the slot structure. The
 * effect's mechanics only care about WHERE the effect copies fall (a copy in a
 * scheduled slot triggers; a copy inside another copy's window does not), and
 * that placement is independent of which non-effect cards fill the remaining
 * positions. So the DP tracks slots ONLY -- no group-count dimensions at all
 * -- and the group composition comes from one ordinary `evaluate()` call on
 * the pool with every effect copy removed.
 *
 * That last part is why the naive closed forms failed: conditioning on "k
 * copies among the first n" mixes two different pools (the non-effect pool for
 * scheduled slots, the still-effect-bearing remainder for window slots). The
 * DP separates "how many cards did I see" (slot structure) from "what was in
 * them" (hypergeometric), so neither pool is fudged.
 *
 * State: (cards consumed, effect copies consumed, scheduled slots used, window
 * credits owed). Every transition consumes exactly one card, so the whole DP
 * is a sweep in `consumed` order. Terminal when the scheduled draws are spent
 * AND no window credits are outstanding -- an effect drawn with the LAST
 * scheduled draw still resolves.
 *
 * "No cascading" is not an assumption here, it is the `e > 0` branch: a copy
 * drawn inside a window is consumed without granting credits. Letting it
 * trigger instead is a one-line change to that branch if the fuller model is
 * ever wanted.
 */
/**
 * EXACT model for a "scry X" / Preordain-style effect against a SINGLE-group
 * threshold query ("acquire at least `threshold` of the tracked group").
 *
 * Unlike the draw case, this one cannot factor the query out: the PLAY depends
 * on card identity (you keep what you still need and bottom the rest), so the
 * DP has to carry group state. Three things keep it small anyway:
 *   - success absorbs. Once `threshold` copies are acquired the outcome is
 *     settled, so live states always have fewer, bounding that dimension by
 *     `threshold` rather than by the group's size.
 *   - no copy of a needed card is ever bottomed, so "acquired" and "consumed"
 *     coincide for the tracked group -- one dimension, not two.
 *   - running out of scheduled draws absorbs too: cards kept on top of the
 *     library are worthless if no draw remains to collect them, which is
 *     exactly the "kept cards cost a draw" fact that a flat additive bonus
 *     cannot express.
 *
 * Every transition consumes exactly one card, so this is a sweep in
 * consumed-card order, same shape as the slot DP.
 *
 * Window copies are bottomed rather than kept (they are not part of the
 * query), which is the same no-cascading treatment the slot DP gives them.
 */
export function exactScryCurveSingleGroup(
  deckSize: number,
  groupCount: number,
  threshold: number,
  copies: number,
  examined: number,
  maxDraws: number,
): Curve {
  const others = deckSize - groupCount - copies;
  const out = new Float64Array(maxDraws + 1);
  if (others < 0) throw new UnsupportedSelectionError('group counts exceed the deck');

  for (let n = 0; n <= maxDraws; n++) {
    // key: acquired|copiesConsumed|othersConsumed|scheduledLeft|credits
    let live = new Map<string, number>();
    live.set(`0|0|0|${n}|0`, 1);
    let success = 0;

    while (live.size > 0) {
      const next = new Map<string, number>();
      for (const [key, p] of live) {
        const [acq, cCons, oCons, sLeft, e] = key.split('|').map(Number) as
          [number, number, number, number, number];
        if (acq >= threshold) { success += p; continue; }
        const remA = groupCount - acq;
        const remC = copies - cCons;
        const remO = others - oCons;
        const rem = remA + remC + remO;
        // No draws left to collect anything: a card kept on top is worthless,
        // so nothing further can be acquired and this branch has failed.
        if (sLeft <= 0 || rem <= 0) continue;

        const add = (a2: number, c2: number, o2: number, s2: number, e2: number, w: number): void => {
          if (w <= 0) return;
          const k = `${a2}|${c2}|${o2}|${s2}|${e2}`;
          next.set(k, (next.get(k) ?? 0) + w);
        };
        const pA = remA / rem, pC = remC / rem, pO = remO / rem;

        if (e > 0) {
          // Window slot: keep what's needed (costing a future draw), bottom
          // the rest (gone from the pool, costing nothing).
          add(acq + 1, cCons, oCons, sLeft - 1, e - 1, p * pA);
          add(acq, cCons + 1, oCons, sLeft, e - 1, p * pC);
          add(acq, cCons, oCons + 1, sLeft, e - 1, p * pO);
        } else {
          // Scheduled draw. A copy drawn here resolves and grants credits.
          add(acq + 1, cCons, oCons, sLeft - 1, e, p * pA);
          add(acq, cCons + 1, oCons, sLeft - 1, e + examined, p * pC);
          add(acq, cCons, oCons + 1, sLeft - 1, e, p * pO);
        }
      }
      live = next;
    }
    out[n] = success;
  }
  return out;
}

/** One terminal outcome of the slot DP: `seen` cards consumed, `copies` of
 * them known to be effect copies, with probability `p`. */
export interface SlotOutcome {
  seen: number;
  copies: number;
  p: number;
}

const slotCache = new Map<string, SlotOutcome[][]>();

/**
 * The slot structure alone: for each scheduled draw count 0..maxDraws, the
 * distribution over (cards seen, effect copies among them).
 *
 * Depends ONLY on (deckSize, effectCount, examined) -- not on the query, not
 * on any group's count. That independence is what makes this affordable:
 * a grid sweeping one group's copies, or a target change, reuses the same
 * distribution instead of recomputing it per row (cached here; measured at
 * ~160ms for a 99-card deck with 12 copies, which is worth not repeating).
 */
export function slotDistribution(
  deckSize: number,
  effectCount: number,
  examined: number,
  maxDraws: number,
): SlotOutcome[][] {
  const cacheKey = `${deckSize}|${effectCount}|${examined}|${maxDraws}`;
  const hit = slotCache.get(cacheKey);
  if (hit !== undefined) return hit;

  const byDraws: SlotOutcome[][] = [];
  for (let n = 0; n <= maxDraws; n++) {
    const outcomes: SlotOutcome[] = [];
    let live = new Map<string, number>();
    live.set(`0|0|0`, 1);
    let consumed = 0;

    while (live.size > 0) {
      const next = new Map<string, number>();
      for (const [key, p] of live) {
        const [cCopies, s, e] = key.split('|').map(Number) as [number, number, number];
        const remDeck = deckSize - consumed;
        if ((s >= n && e === 0) || remDeck <= 0) {
          outcomes.push({ seen: consumed, copies: cCopies, p });
          continue;
        }
        const pCopy = (effectCount - cCopies) / remDeck;
        const add = (c2: number, s2: number, e2: number, w: number): void => {
          if (w <= 0) return;
          const k = `${c2}|${s2}|${e2}`;
          next.set(k, (next.get(k) ?? 0) + w);
        };
        if (e > 0) {
          // Window slot: a copy found here is consumed WITHOUT triggering.
          // "No cascading" is this branch, not an assumption layered on top.
          add(cCopies + 1, s, e - 1, p * pCopy);
          add(cCopies, s, e - 1, p * (1 - pCopy));
        } else {
          add(cCopies + 1, s + 1, e + examined, p * pCopy);
          add(cCopies, s + 1, e, p * (1 - pCopy));
        }
      }
      live = next;
      consumed++;
    }
    byDraws.push(outcomes);
  }
  slotCache.set(cacheKey, byDraws);
  return byDraws;
}

export function exactDrawCurve(
  dnf: Dnf,
  sizes: Sizes,
  deckSize: number,
  effectCount: number,
  examined: number,
  maxDraws: number,
): Curve {
  // Composition of the seen cards, given how many of them were effect copies:
  // one evaluate() on the pool with every copy removed.
  const nonEffect = evaluate(deckSize - effectCount, sizes, dnf).curve;
  const slots = slotDistribution(deckSize, effectCount, examined, maxDraws);
  const out = new Float64Array(maxDraws + 1);

  for (let n = 0; n <= maxDraws; n++) {
    let total = 0;
    for (const { seen, copies, p } of slots[n]!) {
      const idx = Math.min(Math.max(0, seen - copies), nonEffect.length - 1);
      total += p * nonEffect[idx]!;
    }
    out[n] = total;
  }
  return out;
}

/** Kept only as the reference implementation the split version is checked
 * against -- same DP, slot bookkeeping inlined with the query evaluation. */
export function exactDrawCurveUnsplit(
  dnf: Dnf,
  sizes: Sizes,
  deckSize: number,
  effectCount: number,
  examined: number,
  maxDraws: number,
): Curve {
  const nonEffect = evaluate(deckSize - effectCount, sizes, dnf).curve;
  const out = new Float64Array(maxDraws + 1);

  for (let n = 0; n <= maxDraws; n++) {
    // key: consumed|copies|scheduled|credits
    let live = new Map<string, number>();
    live.set(`0|0|0|0`, 1);
    let total = 0;
    let consumed = 0;

    while (live.size > 0) {
      const next = new Map<string, number>();
      for (const [key, p] of live) {
        const [, cCopies, s, e] = key.split('|').map(Number) as [number, number, number, number];
        const remDeck = deckSize - consumed;
        const terminal = (s >= n && e === 0) || remDeck <= 0;
        if (terminal) {
          // Seen `consumed` cards, `cCopies` of them known effect copies.
          const idx = Math.min(consumed - cCopies, nonEffect.length - 1);
          total += p * nonEffect[Math.max(0, idx)]!;
          continue;
        }
        const remCopies = effectCount - cCopies;
        const pCopy = remCopies / remDeck;
        const inWindow = e > 0; // window slots never trigger (no cascading)
        const add = (c2: number, s2: number, e2: number, w: number): void => {
          if (w <= 0) return;
          const k = `${consumed + 1}|${c2}|${s2}|${e2}`;
          next.set(k, (next.get(k) ?? 0) + w);
        };
        if (inWindow) {
          add(cCopies + 1, s, e - 1, p * pCopy);
          add(cCopies, s, e - 1, p * (1 - pCopy));
        } else {
          add(cCopies + 1, s + 1, e + examined, p * pCopy);
          add(cCopies, s + 1, e, p * (1 - pCopy));
        }
      }
      live = next;
      consumed++;
    }
    out[n] = total;
  }
  return out;
}

function chooseN(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

/**
 * All four effect shapes against a SINGLE-group threshold query, in one
 * recursive value function -- the shape only changes how a window resolves,
 * never the surrounding process, which is the point of settling the taxonomy
 * as mechanical axes rather than as a case per card name.
 *
 * Windows resolve ATOMICALLY here (enumerate the whole window's composition,
 * then decide) rather than card-by-card. That's required for ponder, whose
 * shuffle-or-keep decision is made with the whole window visible, and it
 * removes the "credits owed" dimension for the others. `exactScryCurveSingleGroup`
 * keeps the card-by-card formulation deliberately: two independent derivations
 * of the same number, cross-checked in the tests.
 *
 * Window resolution per shape:
 *  - draw:    acquire everything; window leaves the pool; no draw cost.
 *  - impulse: acquire up to `keepMax`; the rest is exiled; no draw cost.
 *  - scry:    acquire the useful ones, each COSTING a draw; rest bottomed.
 *  - ponder:  max(reorder, shuffle). Reorder consumes the whole window as
 *             draws (useful first), so its advance is zero -- the two halves
 *             of "sees ahead" and "stalls your draws" cancel exactly. Shuffle
 *             puts the window back and continues. All of ponder's value is the
 *             OPTION, plus best-of-window when the goal turn cuts through it.
 */
export function exactSelectionCurveSingleGroup(
  deckSize: number,
  groupCount: number,
  threshold: number,
  effect: SelectionEffect,
  copies: number,
  maxDraws: number,
): Curve {
  const others = deckSize - groupCount - copies;
  if (others < 0) throw new UnsupportedSelectionError('group counts exceed the deck');
  const { examined, keepMax, keptCostsDraw, nonKeptLeavesPool } = effect;
  const canShuffle = effect.canShuffle ?? false;
  const memo = new Map<string, number>();

  /** P(success | acquired, tracked-group cards consumed, copies consumed,
   * others consumed, scheduled draws left).
   *
   * `aCons` is tracked SEPARATELY from `acq` because they genuinely differ: an
   * impulse that can only take one card EXILES the second useful one it sees,
   * so that copy is gone from the pool without ever being acquired. Deriving
   * the remaining count from `acq` instead left exiled copies drawable and
   * overstated impulse by up to 2 points -- caught by the brute force. */
  function V(acq: number, aCons: number, cCons: number, oCons: number, sLeft: number): number {
    if (acq >= threshold) return 1;
    if (sLeft <= 0) return 0;
    const remA = groupCount - aCons;
    const remC = copies - cCons;
    const remO = others - oCons;
    const rem = remA + remC + remO;
    if (rem <= 0) return 0;

    const key = `${acq}|${aCons}|${cCons}|${oCons}|${sLeft}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;

    const d = sLeft - 1; // draws left after this one
    let value = (remA / rem) * V(acq + 1, aCons + 1, cCons, oCons, d)
      + (remO / rem) * V(acq, aCons, cCons, oCons + 1, d);

    if (remC > 0) {
      // A copy resolves: enumerate its whole window from the pool left after
      // removing the copy itself.
      const pA2 = remA, pC2 = remC - 1, pO2 = remO;
      const pool = pA2 + pC2 + pO2;
      const w = Math.min(examined, pool);
      const denom = chooseN(pool, w);
      let effectValue = 0;
      if (denom <= 0) {
        effectValue = V(acq, aCons, cCons + 1, oCons, d);
      } else {
        for (let a = 0; a <= Math.min(pA2, w); a++) {
          for (let c = 0; c <= Math.min(pC2, w - a); c++) {
            const o = w - a - c;
            if (o < 0 || o > pO2) continue;
            const p = (chooseN(pA2, a) * chooseN(pC2, c) * chooseN(pO2, o)) / denom;
            if (p <= 0) continue;
            let branch: number;
            if (!keptCostsDraw) {
              // draw / impulse: what you take goes to hand for free; the whole
              // window leaves the pool either way (into hand, or exiled).
              const taken = Math.min(a, keepMax);
              branch = V(acq + taken, aCons + a, cCons + 1 + c, oCons + o, d);
            } else if (nonKeptLeavesPool) {
              // scry: each kept card costs one of your remaining draws.
              const taken = Math.min(a, Math.min(keepMax, d));
              branch = V(acq + taken, aCons + a, cCons + 1 + c, oCons + o, d - taken);
            } else {
              // ponder: reorder (whole window consumed as draws, useful first)
              // vs shuffle it back, if this effect can shuffle at all.
              const reorder = d >= w
                ? V(acq + a, aCons + a, cCons + 1 + c, oCons + o, d - w)
                : (acq + Math.min(a, d) >= threshold ? 1 : 0);
              branch = canShuffle
                ? Math.max(reorder, V(acq, aCons, cCons + 1, oCons, d))
                : reorder;
            }
            effectValue += p * branch;
          }
        }
      }
      value += (remC / rem) * effectValue;
    }
    memo.set(key, value);
    return value;
  }

  const out = new Float64Array(maxDraws + 1);
  for (let n = 0; n <= maxDraws; n++) out[n] = V(0, 0, 0, 0, n);
  return out;
}

export interface TrackedGroup {
  /** Copies in the deck. */
  count: number;
  /** How many must reach hand for this group's part of the query (the `>=`). */
  need: number;
  /** Most that may reach hand. Defaults to `count` (no upper bound). Set 0 for
   * a brick/garnet group you want to AVOID drawing, or k for "at most k".
   *
   * Upper bounds change the model's character, they don't just add a check:
   *   - success stops absorbing (satisfied on turn 3, busted on turn 4), so
   *     bounded branches run to the draw horizon instead of returning early;
   *   - a bounded group can never be folded into the filler pool, since a later
   *     copy can still bust it (folding is the main speedup, so mixed queries
   *     keep it for their unbounded groups only);
   *   - keeping a useful card stops being automatically right, and DECLINING is
   *     a real move -- which is exactly why look-and-bottom effects protect you
   *     here while drawing cannot. Scheduled draws are forced.
   * A bound of 0 buys some of that back: busting is absorbing FAILURE, which
   * prunes hard, and the group needs no state dimension at all. */
  hi?: number;
}

/** One group's bounds within a clause. `hi` defaults to the group's count
 * (no upper bound). `{ lo: 0, hi: 0 }` is a brick you must not draw. */
export interface Bound {
  lo: number;
  hi?: number;
}

/** A clause: bounds per group index, positionally. A missing entry means the
 * clause doesn't care about that group. */
export type SelectionClause = Array<Bound | undefined>;

/**
 * All four effect shapes against a full DNF -- an OR of clauses, each clause an
 * AND of per-group bounds. This is the general entry point; `exactSelectionCurveAnd`
 * is the single-clause case and delegates here.
 *
 * OR is not a new concept for the model (the keep-choice max already covers
 * "which clause am I pursuing", since it maximizes over commit vectors and the
 * value function evaluates every clause), but it does cost state, and the
 * reasons are worth naming:
 *   - a group appearing in two clauses with different `lo` has to be tracked to
 *     the HIGHER one, so caps rise;
 *   - a group can only be folded into the filler pool when EVERY still-alive
 *     clause is both satisfied in it and unbounded on it -- with several clauses
 *     that's rarer, and folding is the main speedup;
 *   - busting can no longer prune: exceeding one clause's upper bound is fine if
 *     another clause tolerates it, so a forced draw that kills clause 1 has to
 *     keep going for clause 2. The single-clause path lost its early bust-exit
 *     as a result, which is a real cost paid for generality.
 *
 * A dead clause stays dead (acquired counts only rise), so aliveness is
 * monotone and can be recomputed cheaply instead of carried in the state.
 */
export function exactSelectionCurveDnf(
  deckSize: number,
  groupCounts: number[],
  clauses: SelectionClause[],
  effect: SelectionEffect,
  copies: number,
  maxDraws: number,
  /** Replace the max over commit vectors with a single heuristic choice: keep
   * toward the clause nearest completion, tie-breaking toward the scarcer group.
   * Cuts the branching factor at the cost of exactness -- the result is then a
   * lower bound, since any fixed policy loses to the optimum. Off by default, so
   * the default behaviour remains EXACT. */
  heuristicKeep = false,
): Curve {
  const G = groupCounts.length;
  const C = clauses.length;
  if (C === 0) throw new UnsupportedSelectionError('a query needs at least one clause');
  const trackedTotal = groupCounts.reduce((a, b) => a + b, 0);
  const others0 = deckSize - trackedTotal - copies;
  if (others0 < 0) throw new UnsupportedSelectionError('group counts exceed the deck');

  // lo/hi matrices, and per-clause "nothing can bust this" flags.
  const lo: number[][] = [];
  const hi: number[][] = [];
  const clauseUnbounded: boolean[] = [];
  for (let c = 0; c < C; c++) {
    const rowLo: number[] = [];
    const rowHi: number[] = [];
    let unbounded = true;
    for (let g = 0; g < G; g++) {
      const b = clauses[c]![g];
      rowLo.push(b?.lo ?? 0);
      const h = b?.hi ?? groupCounts[g]!;
      rowHi.push(h);
      if (h < groupCounts[g]!) unbounded = false;
    }
    lo.push(rowLo);
    hi.push(rowHi);
    clauseUnbounded.push(unbounded);
  }
  // How high each group's in-hand count must be tracked: enough to test every
  // clause's lower bound, plus one past any upper bound so busting is visible.
  const caps: number[] = [];
  for (let g = 0; g < G; g++) {
    let cap = 0;
    for (let c = 0; c < C; c++) {
      cap = Math.max(cap, lo[c]![g]!);
      if (hi[c]![g]! < groupCounts[g]!) cap = Math.max(cap, Math.min(groupCounts[g]!, hi[c]![g]! + 1));
    }
    caps.push(cap);
  }

  const { examined, keepMax, keptCostsDraw, nonKeptLeavesPool } = effect;
  const canShuffle = effect.canShuffle ?? false;
  const optionalResolve = effect.optionalResolve ?? false;

  const radices: number[] = [];
  for (let g = 0; g < G; g++) radices.push(groupCounts[g]! + 1, caps[g]! + 1);
  radices.push(copies + 1, others0 + trackedTotal + 1, maxDraws + 1);
  const stateSpace = radices.reduce((a, b) => a * b, 1);
  const dense = stateSpace <= 8_000_000;
  const denseVal = dense ? new Float64Array(stateSpace) : null;
  const denseSeen = dense ? new Uint8Array(stateSpace) : null;
  const sparse = dense ? null : new Map<number, number>();
  const memoGet = (k: number): number | undefined => {
    if (denseSeen !== null) return denseSeen[k] === 1 ? denseVal![k]! : undefined;
    return sparse!.get(k);
  };
  const memoSet = (k: number, v: number): void => {
    if (denseSeen !== null) { denseSeen[k] = 1; denseVal![k] = v; return; }
    sparse!.set(k, v);
  };
  const encode = (rem: number[], remC: number, remO: number, acq: number[], sLeft: number): number => {
    let key = 0;
    let i = 0;
    for (let g = 0; g < G; g++) {
      key = key * radices[i++]! + rem[g]!;
      key = key * radices[i++]! + acq[g]!;
    }
    key = key * radices[i++]! + remC;
    key = key * radices[i++]! + remO;
    key = key * radices[i]! + sLeft;
    return key;
  };

  const alive = (acq: number[], c: number): boolean => {
    for (let g = 0; g < G; g++) if (acq[g]! > hi[c]![g]!) return false;
    return true;
  };
  const met = (acq: number[], c: number): boolean => {
    for (let g = 0; g < G; g++) {
      if (acq[g]! > hi[c]![g]! || acq[g]! < lo[c]![g]!) return false;
    }
    return true;
  };
  const anyMet = (acq: number[]): boolean => {
    for (let c = 0; c < C; c++) if (met(acq, c)) return true;
    return false;
  };

  function V(rem: number[], remC: number, remO: number, acq: number[], sLeft: number): number {
    // Absorbing success needs a clause that is BOTH satisfied and immune to
    // further draws; otherwise a later forced draw could still bust it.
    let anyAlive = false;
    for (let c = 0; c < C; c++) {
      if (!alive(acq, c)) continue;
      anyAlive = true;
      if (clauseUnbounded[c]! && met(acq, c)) return 1;
    }
    if (!anyAlive) return 0; // every clause busted, and dead clauses stay dead
    if (sLeft <= 0) return anyMet(acq) ? 1 : 0;
    const pool = rem.reduce((a, r) => a + r, 0) + remC + remO;
    if (pool <= 0) return anyMet(acq) ? 1 : 0;

    // Fold a group into the filler pool only when every still-alive clause is
    // satisfied on it AND cannot be busted by it.
    for (let g = 0; g < G; g++) {
      if (rem[g]! <= 0) continue;
      let foldable = true;
      for (let c = 0; c < C; c++) {
        if (!alive(acq, c)) continue;
        if (hi[c]![g]! < groupCounts[g]! || acq[g]! < lo[c]![g]!) { foldable = false; break; }
      }
      if (foldable) {
        const spare = rem[g]!;
        rem[g] = 0;
        const folded = V(rem, remC, remO + spare, acq, sLeft);
        rem[g] = spare;
        return folded;
      }
    }

    const key = encode(rem, remC, remO, acq, sLeft);
    const hit = memoGet(key);
    if (hit !== undefined) return hit;

    const d = sLeft - 1;
    let value = (remO / pool) * V(rem, remC, remO - 1, acq, d);
    for (let g = 0; g < G; g++) {
      const oldR = rem[g]!;
      if (oldR <= 0) continue;
      const oldA = acq[g]!;
      // No bust-prune here: exceeding one clause's bound may be fine for
      // another, so the branch has to be evaluated rather than zeroed.
      rem[g] = oldR - 1;
      acq[g] = Math.min(caps[g]!, oldA + 1);
      value += (oldR / pool) * V(rem, remC, remO, acq, d);
      rem[g] = oldR;
      acq[g] = oldA;
    }

    if (remC > 0) {
      const poolAfter = pool - 1;
      const remC2 = remC - 1;
      const w = Math.min(examined, poolAfter);
      const denom = chooseN(poolAfter, w);
      let effectValue = 0;
      if (denom <= 0 || w <= 0) {
        effectValue = V(rem, remC2, remO, acq, d);
      } else {
        const comp: number[] = new Array(G).fill(0) as number[];
        const walk = (g: number, left: number, ways: number): void => {
          if (g === G) {
            for (let c = 0; c <= Math.min(remC2, left); c++) {
              const o = left - c;
              if (o < 0 || o > remO) continue;
              const p = (ways * chooseN(remC2, c) * chooseN(remO, o)) / denom;
              if (p <= 0) continue;
              effectValue += p * resolveWindow([...comp], c, o, d);
            }
            return;
          }
          const maxTake = Math.min(rem[g]!, left);
          for (let take = 0; take <= maxTake; take++) {
            comp[g] = take;
            walk(g + 1, left - take, ways * chooseN(rem[g]!, take));
          }
          comp[g] = 0;
        };
        walk(0, w, 1);
      }
      if (optionalResolve) {
        // Casting is a choice, and it's made BEFORE the window is revealed --
        // so the comparison is against the expectation over windows, not
        // per-window hindsight. Declining leaves the copy as a spent draw.
        effectValue = Math.max(effectValue, V(rem, remC2, remO, acq, d));
      }
      value += (remC / pool) * effectValue;
    }
    memoSet(key, value);
    return value;

    function resolveWindow(wComp: number[], wC: number, wO: number, drawsLeft: number): number {
      const windowSize = wComp.reduce((a, x) => a + x, 0) + wC + wO;
      const remCAfter = remC - 1 - wC;
      const remOAfter = remO - wO;
      const shuffleBranch = (keptCostsDraw && !nonKeptLeavesPool && canShuffle)
        ? V(rem, remC - 1, remO, acq, drawsLeft)
        : -1;
      for (let g = 0; g < G; g++) rem[g] = rem[g]! - wComp[g]!;
      const restorePool = (): void => {
        for (let g = 0; g < G; g++) rem[g] = rem[g]! + wComp[g]!;
      };
      const saved: number[] = new Array(G).fill(0) as number[];

      if (!keptCostsDraw) {
        // draw / impulse. A draw effect forces its whole window into hand, so
        // there is nothing to choose; impulse picks up to keepMax.
        let best = -1;
        const pick = (g: number, budget: number): void => {
          if (g === G) {
            best = Math.max(best, V(rem, remCAfter, remOAfter, acq, drawsLeft));
            return;
          }
          const maxTake = Math.min(wComp[g]!, budget);
          const forced = keepMax >= windowSize ? maxTake : 0;
          for (let k = forced; k <= maxTake; k++) {
            saved[g] = acq[g]!;
            acq[g] = Math.min(caps[g]!, acq[g]! + k);
            pick(g + 1, budget - k);
            acq[g] = saved[g]!;
          }
        };
        pick(0, Math.min(keepMax, windowSize));
        restorePool();
        return best;
      }

      if (nonKeptLeavesPool) {
        // scry: each kept card costs one of the remaining draws.
        if (heuristicKeep) {
          // One commit vector chosen by rule instead of maximising over all of
          // them: prefer the clause NEAREST completion (fewest cards still
          // wanted), tie-break toward the SCARCER group (fewer copies left in the
          // pool). Trades exactness for a smaller branching factor.
          let budget = Math.min(keepMax, drawsLeft, windowSize);
          const order = groupCounts.map((_v: number, g: number) => g).sort((a, b) => {
            const needA = Math.min(...clauses.map((_c, ci) => Math.max(0, lo[ci]![a]! - acq[a]!)));
            const needB = Math.min(...clauses.map((_c, ci) => Math.max(0, lo[ci]![b]! - acq[b]!)));
            if (needA !== needB) return needA - needB;
            return rem[a]! - rem[b]!;
          });
          let spent = 0;
          for (const g of order) {
            if (budget <= 0) break;
            let want = 0;
            for (let ci = 0; ci < C; ci++) want = Math.max(want, lo[ci]![g]! - acq[g]!);
            const take = Math.min(wComp[g]!, Math.max(0, want), budget);
            saved[g] = acq[g]!;
            acq[g] = Math.min(caps[g]!, acq[g]! + take);
            budget -= take;
            spent += take;
          }
          const out = V(rem, remCAfter, remOAfter, acq, drawsLeft - spent);
          for (const g of order) acq[g] = saved[g]!;
          restorePool();
          return out;
        }
        let best = -1;
        const pick = (g: number, budget: number, spent: number): void => {
          if (g === G) {
            best = Math.max(best, V(rem, remCAfter, remOAfter, acq, drawsLeft - spent));
            return;
          }
          const maxTake = Math.min(wComp[g]!, budget);
          for (let k = 0; k <= maxTake; k++) {
            saved[g] = acq[g]!;
            acq[g] = Math.min(caps[g]!, acq[g]! + k);
            pick(g + 1, budget - k, spent + k);
            acq[g] = saved[g]!;
          }
        };
        pick(0, Math.min(keepMax, drawsLeft, windowSize), 0);
        restorePool();
        return best;
      }

      // ponder: reorder (whole window consumed as draws) vs shuffle it back.
      let reorder: number;
      if (drawsLeft >= windowSize) {
        for (let g = 0; g < G; g++) {
          saved[g] = acq[g]!;
          acq[g] = Math.min(caps[g]!, acq[g]! + wComp[g]!);
        }
        reorder = V(rem, remCAfter, remOAfter, acq, drawsLeft - windowSize);
        for (let g = 0; g < G; g++) acq[g] = saved[g]!;
      } else {
        // Exactly `drawsLeft` of the window gets drawn -- you choose which, not
        // how many, so the untracked window cards must absorb the remainder.
        let best = -1;
        const take: number[] = new Array(G).fill(0) as number[];
        const untrackedInWindow = wC + wO;
        const pick = (g: number, budget: number): void => {
          if (g === G) {
            if (budget > untrackedInWindow) return;
            const probe: number[] = [];
            for (let i = 0; i < G; i++) probe.push(Math.min(caps[i]!, acq[i]! + take[i]!));
            best = Math.max(best, anyMet(probe) ? 1 : 0);
            return;
          }
          const maxTake = Math.min(wComp[g]!, budget);
          for (let k = 0; k <= maxTake; k++) {
            take[g] = k;
            pick(g + 1, budget - k);
          }
          take[g] = 0;
        };
        pick(0, drawsLeft);
        reorder = best;
      }
      restorePool();
      return canShuffle ? Math.max(reorder, shuffleBranch) : reorder;
    }
  }

  const out = new Float64Array(maxDraws + 1);
  const rem0 = [...groupCounts];
  const acq0 = new Array(G).fill(0) as number[];
  for (let n = 0; n <= maxDraws; n++) out[n] = V(rem0, copies, others0, acq0, n);
  return out;
}

/** Single-clause case: an AND of per-group thresholds. Delegates to the DNF
 * engine so there is one implementation, not two that can drift. */
export function exactSelectionCurveAnd(
  deckSize: number,
  groups: TrackedGroup[],
  effect: SelectionEffect,
  copies: number,
  maxDraws: number,
): Curve {
  return exactSelectionCurveDnf(
    deckSize,
    groups.map((g) => g.count),
    [groups.map((g) => ({ lo: g.need, hi: g.hi ?? g.count }))],
    effect,
    copies,
    maxDraws,
  );
}

/** One draw-shaped effect type: `count` copies that each examine `examined`
 * extra cards, all of which go to hand. */
export interface DrawEffectType {
  count: number;
  examined: number;
}

const multiSlotCache = new Map<string, SlotOutcome[][]>();

/**
 * `slotDistribution` for SEVERAL draw-shaped effect types at once -- what
 * cantrips.ts needs, since a deck runs "draw 1" and "look 3" side by side.
 *
 * Still query-independent, so still cached. Types are tracked separately
 * because they grant different numbers of window slots, but the outcome only
 * reports the TOTAL copies seen: for the query's purposes every copy is just a
 * non-resource card, and the composition of the rest is conditionally
 * hypergeometric given the slot structure (the same factorization that makes
 * the single-type version cheap).
 *
 * This also removes a whole bug class by construction. The old flat form drew
 * each type's count from its own independent hypergeometric over the same draw
 * count, so two types could "draw" more copies than cards seen; and pooling
 * types into one average bonus produced non-integer curve indices (CLAUDE.md
 * #15). Here the types share one sequential process, so neither is expressible.
 */
export function slotDistributionMulti(
  deckSize: number,
  types: DrawEffectType[],
  maxDraws: number,
): SlotOutcome[][] {
  const cacheKey = `${deckSize}|${types.map((t) => `${t.count}:${t.examined}`).join(';')}|${maxDraws}`;
  const hit = multiSlotCache.get(cacheKey);
  if (hit !== undefined) return hit;

  const T = types.length;
  const byDraws: SlotOutcome[][] = [];
  for (let n = 0; n <= maxDraws; n++) {
    const outcomes: SlotOutcome[] = [];
    // key: seen counts per type, then scheduled used, then credits owed
    let live = new Map<string, number>();
    live.set(`${new Array(T).fill(0).join(',')}|0|0`, 1);
    let consumed = 0;

    while (live.size > 0) {
      const next = new Map<string, number>();
      for (const [key, p] of live) {
        const [seenPart, sPart, ePart] = key.split('|');
        const seen = seenPart!.split(',').map(Number);
        const s = Number(sPart);
        const e = Number(ePart);
        const remDeck = deckSize - consumed;
        if ((s >= n && e === 0) || remDeck <= 0) {
          outcomes.push({ seen: consumed, copies: seen.reduce((a, x) => a + x, 0), p });
          continue;
        }
        const add = (seen2: number[], s2: number, e2: number, w: number): void => {
          if (w <= 0) return;
          const k = `${seen2.join(',')}|${s2}|${e2}`;
          next.set(k, (next.get(k) ?? 0) + w);
        };
        let copyProb = 0;
        for (let i = 0; i < T; i++) {
          const remCopies = types[i]!.count - seen[i]!;
          if (remCopies <= 0) continue;
          const pi = remCopies / remDeck;
          copyProb += pi;
          const seen2 = [...seen];
          seen2[i] = seen[i]! + 1;
          // A copy found inside a window is consumed without triggering.
          if (e > 0) add(seen2, s, e - 1, p * pi);
          else add(seen2, s + 1, e + types[i]!.examined, p * pi);
        }
        const pOther = 1 - copyProb;
        if (pOther > 0) {
          if (e > 0) add(seen, s, e - 1, p * pOther);
          else add(seen, s + 1, e, p * pOther);
        }
      }
      live = next;
      consumed++;
    }
    byDraws.push(outcomes);
  }
  multiSlotCache.set(cacheKey, byDraws);
  return byDraws;
}

/** Exact curve for any number of draw-shaped effect types. Zero types, or all
 * counts zero, reproduces `evaluate()` exactly. */
export function exactDrawCurveMulti(
  dnf: Dnf,
  sizes: Sizes,
  deckSize: number,
  types: DrawEffectType[],
  maxDraws: number,
): Curve {
  const active = types.filter((t) => t.count > 0);
  const totalCopies = active.reduce((a, t) => a + t.count, 0);
  const nonEffect = evaluate(deckSize - totalCopies, sizes, dnf).curve;
  const out = new Float64Array(maxDraws + 1);
  if (active.length === 0) {
    const plain = evaluate(deckSize, sizes, dnf).curve;
    for (let n = 0; n <= maxDraws; n++) out[n] = plain[Math.min(n, plain.length - 1)] ?? 0;
    return out;
  }
  const slots = slotDistributionMulti(deckSize, active, maxDraws);
  for (let n = 0; n <= maxDraws; n++) {
    let total = 0;
    for (const { seen, copies, p } of slots[n]!) {
      const idx = Math.min(Math.max(0, seen - copies), nonEffect.length - 1);
      total += p * nonEffect[idx]!;
    }
    out[n] = total;
  }
  return out;
}
