/**
 * The modified-query method for SCRY-shaped effects (look at S, keep any on top,
 * bottom the rest -- keeps cost a future draw).
 *
 * NOT EXACT and NOT CURRENTLY A FAST PATH. Both claims corrected by running the
 * standard validation table (see `modifiedQueryScry.report.test.ts`):
 *
 *  - Accuracy: 8 of 10 measured configurations fall outside the 0.1pt bar. Worst
 *    is +2.61pt at LOW DRAW COUNTS (8 copies of a look-3 over 6 draws), not the
 *    OR-plus-brick corner (+1.38pt) that earlier notes called the worst -- few
 *    draws means keeps steal a large fraction of them. Only a 20-draw config
 *    lands in bar (+0.099pt).
 *  - Cost: correct profile for a SUPPLEMENT -- much faster where the exact DP is
 *    expensive (375ms vs 15327ms on the OR-plus-brick corner, 215ms vs 635ms with
 *    one bounded clause), and slower where the DP is already cheap (290ms vs
 *    146ms on a plain monotone query). Use it only in the corner it is for.
 *
 * The cost history is worth keeping, because the middle measurement was
 * misleading: a single uncorrected pass was ~370ms, the fixed point naively
 * implemented was ~3800ms (10 iterations x a full pass), and it is back to ~380ms
 * now that convergence iterations skip the query evaluation entirely. Keeps depend
 * only on window composition and collectable draws, never on the query's
 * probability, so every iteration but the last was paying for `evaluate()` calls
 * it discarded. Values are bit-identical before and after.
 *
 * `exactSelectionCurveDnf` remains the only SHIPPING path for scry. Kept as a real
 * file because it was previously rebuilt from scratch inside throwaway test files
 * six times in one session, which made cross-variant comparisons unreliable.
 *
 * The identity it rests on: `hold = seen - ditched`. Whatever a look effect made
 * you let go simply shifts the query -- lower bounds and brick caps alike.
 * Implemented as the rearrangement `fresh >= lo - kept` (see `shiftDnf`), which
 * is algebraically the same statement evaluated over the remaining draws instead
 * of over the seen population, and lets `evaluate()` do the work.
 *
 * TWO CORRECTIONS ALREADY IN, both found by targeted tests rather than by
 * inspection:
 *
 * 1. KEEPS CAPPED AT AVAILABLE DRAWS. A kept card sits on top of the library and
 *    costs a draw to collect, so you cannot keep more than you have draws left.
 *    Without this the remaining-draw index goes negative, clamps to zero, and the
 *    kept cards stay credited -- cards without the draws that fetch them. The
 *    stacked-deck oracle (fill every non-query slot with a scry-100: the answer is
 *    the no-scry base rate until the needed count T, then exactly 1) exposed this
 *    as P=1 where the truth was 0.0316, a 97pt error. Invisible at ordinary look
 *    sizes, catastrophic at the boundary.
 *
 * 2. THE TRIGGER/KEEPS FIXED POINT. Keeps consume draws, so fewer scheduled draws
 *    reveal fresh library cards, so fewer copies are found, so fewer windows open,
 *    so there are fewer keeps. Triggers and keeps are mutually determined. Taking
 *    the trigger count from a draw-shaped slot distribution (where windows are
 *    free) over-counts them, with the error growing in copy count. Iterating to a
 *    fixed point converges in 7-10 passes and halves the residual; crucially it
 *    keeps total probability mass at exactly 1, because it COMPOSES two proper
 *    distributions rather than constructing a new joint. An earlier one-shot joint
 *    lost 5-8% of its mass and was wrongly read as proof that the coupling could
 *    not be solved.
 *
 * KNOWN REMAINING RESIDUAL, ~1.4pt worst case: NOT a mean-field bias. Iterating
 * on the full distribution of keeps instead of its mean was implemented and
 * measured, and it changed the answer by 0.001-0.004pt while costing 3-10x more
 * time -- so collapsing keeps to a mean is free here (the keep distribution sits
 * on {0,1,2} and the map is not nonlinear enough over that range). That variant
 * was deleted; see PLAN.md.
 *
 * What remains is cross-window TIMING: all windows are pooled into a single
 * composition and a single keep decision, so keeps from a window that resolved
 * after the draws were already spent still get credited. The composition sampling
 * itself is sound (conditional on the window contents, the remaining pool really
 * does hold `counts - window`, which is why the no-keeps case is exact) -- the
 * unjustified step is treating every window as resolving before every draw.
 *
 * Also inherited: no cascading (a copy inside a window is bottomed and never
 * chains), which both this and the exact DP assume, so real play is somewhat
 * better than either reports.
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

/** Thrown when the trigger count cannot be recovered from the slot distribution
 * (see `assertInvertible`). */
export class ScryInversionError extends Error {}

/**
 * This module recovers the trigger count as `(seen - draws) / examined`, which is
 * only valid while no window is truncated by the end of the deck. Once
 * `draws + copies * examined` can exceed the deck, `slotDistribution` caps `seen`
 * at deck size and the inversion silently reads too few triggers -- which sent a
 * stacked-deck oracle case to P=1 against a true 0.0316, because with zero
 * triggers the model draws only from the non-copy pool.
 *
 * Guarded rather than approximated. The real fix is for `slotDistribution` to
 * report triggers directly instead of having callers invert `seen`; that touches
 * the shipped draw-shaped path, so it is recorded in PLAN.md rather than done
 * here.
 */
function assertInvertible(deckSize: number, copies: number, examined: number, draws: number): void {
  if (draws + copies * examined > deckSize) {
    throw new ScryInversionError(
      `trigger count is not recoverable: draws(${draws}) + copies(${copies})*examined(${examined}) `
      + `exceeds deck(${deckSize}), so windows truncate and seen saturates`,
    );
  }
}

export interface ScryPassResult {
  /** P(query) under this pass. */
  p: number;
  /** Expected number of cards kept (and therefore draws spent collecting them). */
  expectedKeeps: number;
  /** Total probability mass accounted for. Must be 1; a shortfall means the
   * enumeration is not a partition of the sample space. */
  mass: number;
}

/**
 * One pass of the method.
 *
 * `slotDraws` is how many scheduled draws are assumed to reveal FRESH library
 * cards -- the quantity the fixed point solves for. `draws` stays the real draw
 * budget. Passing `slotDraws === draws` reproduces the uncorrected version.
 */
export function scryModifiedQueryPass(
  deckSize: number,
  counts: number[],
  clauses: SelectionClause[],
  copies: number,
  examined: number,
  draws: number,
  slotDraws: number,
  /** Skip the query evaluation and accumulate only the keep count. The fixed
   * point converges on KEEPS, which depend solely on the window composition and
   * the draws available to collect them -- never on the query's probability. So
   * every iteration but the last was paying for `evaluate()` calls it discarded,
   * which is where the ~10x went. */
  keepsOnly = false,
): ScryPassResult {
  assertInvertible(deckSize, copies, examined, draws);
  const G = counts.length;
  const ids: GroupId[] = counts.map((_, i) => `g${i}`);
  const pool = deckSize - copies;
  const tracked = counts.reduce((a, c) => a + c, 0);
  const fillerPool = pool - tracked;
  if (fillerPool < 0) throw new Error('group counts exceed the deck');

  const dnf: Dnf = {
    clauses: clauses.map((cl) => {
      const box: Record<GroupId, { lo: number; hi: number }> = {};
      cl.forEach((b, i) => { box[ids[i]!] = { lo: b?.lo ?? 0, hi: b?.hi ?? counts[i]! }; });
      return box;
    }),
    monotone: false,
  };
  const fullSizes: Record<GroupId, number> = {};
  counts.forEach((c, i) => { fullSizes[ids[i]!] = c; });
  /** The most any clause asks of a group: all a scry would bother keeping. */
  const maxLo = counts.map((_, gi) => Math.max(...clauses.map((cl) => cl[gi]?.lo ?? 0)));

  const effSlotDraws = Math.max(0, Math.round(slotDraws));
  let p = 0;
  let expectedKeeps = 0;
  let mass = 0;

  for (const outcome of slotDistribution(deckSize, copies, examined, effSlotDraws)[effSlotDraws]!) {
    if (outcome.p <= 0) continue;
    const triggers = examined > 0 ? Math.round((outcome.seen - effSlotDraws) / examined) : 0;
    const copiesInWindows = outcome.copies - triggers;
    // Real draws left to acquire cards: the copies themselves were drawn and cast.
    const scheduled = draws - triggers;
    const windowNonCopy = Math.min(triggers * examined - copiesInWindows, pool);

    if (triggers === 0 || windowNonCopy <= 0) {
      mass += outcome.p;
      if (!keepsOnly) {
        const curve = evaluate(pool, fullSizes, dnf).curve;
        p += outcome.p * (curve[Math.min(Math.max(0, scheduled), curve.length - 1)] ?? 0);
      }
      continue;
    }

    const window: number[] = new Array(G).fill(0) as number[];
    const walk = (g: number, left: number, ways: number): void => {
      if (g === G) {
        if (left < 0 || left > fillerPool) return;
        const pWindow = (ways * comb(fillerPool, left)) / comb(pool, windowNonCopy);
        if (pWindow <= 0) return;

        // Keep every still-missing piece, bottom the rest. Scry forces no
        // discard, so there is no choice to maximise over.
        let kept = window.map((have, gi) => Math.min(have, maxLo[gi]!));
        let spent = kept.reduce((a, x) => a + x, 0);
        const collectable = Math.max(0, scheduled);
        if (spent > collectable) {
          // Correction 1: cannot keep what there is no draw left to collect.
          let over = spent - collectable;
          kept = kept.map((k) => { const cut = Math.min(k, over); over -= cut; return k - cut; });
          spent = kept.reduce((a, x) => a + x, 0);
        }

        const wgt = outcome.p * pWindow;
        mass += wgt;
        expectedKeeps += wgt * spent;
        if (!keepsOnly) {
          const secured: Record<GroupId, number> = {};
          kept.forEach((k, i) => { secured[ids[i]!] = k; });
          const remaining: Record<GroupId, number> = {};
          counts.forEach((c, i) => { remaining[ids[i]!] = c - window[i]!; });
          const curve = evaluate(pool - windowNonCopy, remaining, shiftDnf(dnf, secured)).curve;
          const idx = Math.min(Math.max(0, scheduled - spent), curve.length - 1);
          p += wgt * (curve[idx] ?? 0);
        }
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
  return { p, expectedKeeps, mass };
}

export interface ScryEstimate extends ScryPassResult {
  /** Fixed-point value of expected keeps. */
  keeps: number;
  /** Iterations to convergence (12 means it did not converge). */
  iterations: number;
}

/**
 * Correction 2: solve the trigger/keeps fixed point. Triggers are found among
 * `draws - keeps` fresh reveals, while the keeps come from the windows those
 * triggers opened, so the two are iterated to agreement. Fractional keep counts
 * are handled by blending the two neighbouring integer slot distributions.
 */
export function scryModifiedQuery(
  deckSize: number,
  counts: number[],
  clauses: SelectionClause[],
  copies: number,
  examined: number,
  draws: number,
  maxIterations = 12,
): ScryEstimate {
  let keeps = 0;
  let iterations = 0;

  // Converge the keep count first, WITHOUT evaluating the query: keeps depend on
  // the window composition and the collectable draws only.
  for (; iterations < maxIterations; iterations++) {
    const effective = draws - keeps;
    const lo = Math.floor(effective);
    const hi = Math.ceil(effective);
    const frac = effective - lo;
    const a = scryModifiedQueryPass(deckSize, counts, clauses, copies, examined, draws, lo, true);
    const b = frac === 0 ? a
      : scryModifiedQueryPass(deckSize, counts, clauses, copies, examined, draws, hi, true);
    const next = a.expectedKeeps + frac * (b.expectedKeeps - a.expectedKeeps);
    if (Math.abs(next - keeps) < 1e-10) break;
    keeps = next;
  }

  // One full pass at the converged keep count.
  const effective = draws - keeps;
  const lo = Math.floor(effective);
  const hi = Math.ceil(effective);
  const frac = effective - lo;
  const a = scryModifiedQueryPass(deckSize, counts, clauses, copies, examined, draws, lo);
  const b = frac === 0 ? a
    : scryModifiedQueryPass(deckSize, counts, clauses, copies, examined, draws, hi);
  const blend = (x: number, y: number): number => x + frac * (y - x);
  return {
    p: blend(a.p, b.p),
    expectedKeeps: blend(a.expectedKeeps, b.expectedKeeps),
    mass: blend(a.mass, b.mass),
    keeps,
    iterations,
  };
}
