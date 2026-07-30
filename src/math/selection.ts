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
