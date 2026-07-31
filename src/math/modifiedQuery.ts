/**
 * The "modified query" method: a fast UPPER BOUND for capped-keep selection
 * effects (impulse / surveil -- look at E, keep at most K), for use where the
 * exact DP in selection.ts is too slow.
 *
 * The idea, in one identity: `hold = seen - ditched`. Whatever you saw and had
 * to let go simply shifts the query. A clause needing 2 of A, after ditching
 * one A, needs 3 of A out of the cards you saw; a brick cap of 0, after
 * bottoming a brick, tolerates 1 in the seen population. Lower bounds and
 * upper bounds move by the same rule, which is why bricks need no special case.
 *
 * Implemented as the rearrangement `lo - kept <= scheduled <= hi - kept`, so
 * `shiftDnf` + `evaluate` do the work against the draws that remain.
 *
 * WHY IT IS AN UPPER BOUND (measured: every deviation from the exact DP is
 * positive). Two idealizations, both of which only ever add power:
 *   1. the keep budget is aggregate (`triggers * keepMax` pooled across all
 *      windows), so it can keep two useful cards from one window when the
 *      other window was barren -- real play cannot;
 *   2. keeps are chosen knowing every window's contents at once, rather than
 *      one window at a time as the draw unfolds.
 *
 * ACCURACY (vs the exact DP), and it depends on the draw horizon as much as on
 * the deck: +0.02pt on a 60-card two-clause brick query with 8 copies of a
 * look-3 at 15 draws, but +0.20pt on the SAME query at 10 draws. More draws
 * dilute the idealization, since a pooled keep budget matters less when there
 * is time to draw the pieces anyway. It also degrades on small dense decks
 * (+0.47pt at 40 cards / 8 relevant / look 4, +0.76pt at 12 cards), where the
 * pooled budget bites hardest -- and those are exactly the cases the exact DP
 * handles cheaply, so the intended split is: exact DP when affordable, this
 * when not, with the horizon checked as well as the deck.
 *
 * NOT for scry-shaped effects. With `keepMax` unbounded the aggregate budget is
 * far too permissive (+3.3pt), and a fixed keep-everything-needed rule still
 * lands +2.5pt out because bottoming is credited to draws that happened before
 * the scry existed. See PLAN.md for the measurements and the trigger-position
 * fix that would be needed.
 */
import { evaluate } from './evaluate';
import { shiftDnf } from './reveal';
import { slotDistribution } from './selection';
import type { SelectionClause } from './selection';
import type { Dnf, GroupId } from './expr';

function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

/**
 * P(query) after `draws` scheduled draws, for a deck holding `copies` of a
 * look-`examined`-keep-`keepMax` effect. Groups are positional, matching
 * `exactSelectionCurveDnf`.
 */
export function modifiedQueryUpperBound(
  deckSize: number,
  counts: number[],
  clauses: SelectionClause[],
  copies: number,
  examined: number,
  keepMax: number,
  draws: number,
): number {
  const G = counts.length;
  const ids: GroupId[] = counts.map((_, i) => `g${i}`);
  const pool = deckSize - copies; // non-copy cards
  const trackedTotal = counts.reduce((a, c) => a + c, 0);
  const fillerPool = pool - trackedTotal;
  if (fillerPool < 0) throw new Error('group counts exceed the deck');

  const dnf: Dnf = {
    clauses: clauses.map((cl) => {
      const box: Record<GroupId, { lo: number; hi: number }> = {};
      cl.forEach((b, i) => {
        box[ids[i]!] = { lo: b?.lo ?? 0, hi: b?.hi ?? counts[i]! };
      });
      return box;
    }),
    monotone: clauses.every((cl) => cl.every((b, i) => (b?.hi ?? counts[i]!) >= counts[i]!)),
  };

  const memo = new Map<string, number>();
  const evalShifted = (kept: number[], remCounts: number[], remPool: number, left: number): number => {
    const key = `${kept.join(',')}|${remCounts.join(',')}|${remPool}|${left}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const secured: Record<GroupId, number> = {};
    kept.forEach((k, i) => { secured[ids[i]!] = k; });
    const remSizes: Record<GroupId, number> = {};
    remCounts.forEach((c, i) => { remSizes[ids[i]!] = c; });
    const curve = evaluate(remPool, remSizes, shiftDnf(dnf, secured)).curve;
    const v = curve[Math.min(Math.max(0, left), curve.length - 1)] ?? 0;
    memo.set(key, v);
    return v;
  };

  let total = 0;
  for (const { seen, copies: seenCopies, p } of slotDistribution(deckSize, copies, examined, draws)[draws]!) {
    if (p <= 0) continue;
    const triggers = Math.round((seen - draws) / examined);
    const copiesInWindows = seenCopies - triggers;
    const scheduledNonCopy = draws - triggers;
    const windowNonCopy = triggers * examined - copiesInWindows;
    if (triggers === 0 || windowNonCopy <= 0) {
      total += p * evalShifted(new Array(G).fill(0) as number[], counts, pool, scheduledNonCopy);
      continue;
    }

    // What the windows collectively held, by multivariate hypergeometric.
    const window: number[] = new Array(G).fill(0) as number[];
    const walk = (g: number, left: number, ways: number): void => {
      if (g === G) {
        const filler = left;
        if (filler < 0 || filler > fillerPool) return;
        const pWindow = (ways * comb(fillerPool, filler)) / comb(pool, windowNonCopy);
        if (pWindow <= 0) return;

        // Best keep within the pooled budget; the rest is ditched and shifts
        // the query by exactly the amount let go.
        const budget = Math.min(triggers * keepMax, windowNonCopy);
        const kept: number[] = new Array(G).fill(0) as number[];
        const remCounts = counts.map((c, gi) => c - window[gi]!);
        let best = -1;
        const pick = (i: number, remainingBudget: number): void => {
          if (i === G) {
            best = Math.max(best, evalShifted(kept, remCounts, pool - windowNonCopy, scheduledNonCopy));
            return;
          }
          for (let k = 0; k <= Math.min(window[i]!, remainingBudget); k++) {
            kept[i] = k;
            pick(i + 1, remainingBudget - k);
          }
          kept[i] = 0;
        };
        pick(0, budget);
        total += p * pWindow * best;
        return;
      }
      for (let take = 0; take <= Math.min(counts[g]!, left); take++) {
        window[g] = take;
        walk(g + 1, left - take, ways * comb(counts[g]!, take));
      }
      window[g] = 0;
    };
    walk(0, windowNonCopy, 1);
  }
  return total;
}
