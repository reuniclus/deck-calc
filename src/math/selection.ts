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
