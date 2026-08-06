/**
 * "How many copies of a group do I need to hit P% of finding K of them in the top X
 * cards?" -- the INVERSE of the ordinary question, and the one people actually ask
 * when building a deck.
 *
 * Pure hypergeometry: no effects, no keeps, no policy. Every cell is exact, and one
 * `evaluate` call produces an entire row over X, so the whole cube costs one call per
 * (copies, K) pair rather than one per cell.
 *
 * Monotonicity that makes the inverse well-defined: P is non-decreasing in copies and
 * in X, and non-increasing in K. So the minimum copies for a target is found by
 * scanning upward and stopping -- no search subtleties, and the answer is exact rather
 * than bracketed.
 */
import { evaluate } from './evaluate';

export interface CubeSpec {
  deckSize: number;
  /** Copies of the group to consider, inclusive range. */
  maxCopies: number;
  /** Largest K (how many you need to find). */
  maxNeeded: number;
  /** Largest X (how many cards you see). */
  maxSeen: number;
}

/** `cube[copies][k][x]` = P(at least `k` of `copies` in the top `x`). */
export function successCube(spec: CubeSpec): number[][][] {
  const { deckSize, maxCopies, maxNeeded, maxSeen } = spec;
  const cube: number[][][] = [];
  for (let c = 0; c <= maxCopies; c++) {
    const perK: number[][] = [];
    for (let k = 0; k <= maxNeeded; k++) {
      if (k === 0) {
        perK.push(new Array(maxSeen + 1).fill(1) as number[]);
        continue;
      }
      if (k > c) {
        perK.push(new Array(maxSeen + 1).fill(0) as number[]);
        continue;
      }
      const curve = evaluate(deckSize, { A: c }, {
        clauses: [{ A: { lo: k, hi: c } }], monotone: true,
      }).curve;
      const row: number[] = [];
      for (let x = 0; x <= maxSeen; x++) row.push(curve[Math.min(x, curve.length - 1)] ?? 0);
      perK.push(row);
    }
    cube.push(perK);
  }
  return cube;
}

export interface CopiesQuery {
  deckSize: number;
  /** How many you need to find. */
  needed: number;
  /** How many cards you will see. */
  seen: number;
  /** Target probability, e.g. 0.9. */
  target: number;
  /** Cap on how many copies to consider (default: the deck). */
  maxCopies?: number;
}

export interface CopiesAnswer {
  /** Fewest copies reaching the target, or null if the cap cannot reach it. */
  copies: number | null;
  /** Probability actually achieved at that count (>= target). */
  achieved: number;
  /** Probability one copy fewer -- the marginal value of the last copy. */
  achievedOneFewer: number;
}

/**
 * Fewest copies to reach `target`. Also reports what one fewer achieves, because the
 * marginal copy is the decision people are really making -- going from 0.89 to 0.91 is
 * rarely worth a slot, and the raw answer hides that.
 */
export function copiesNeeded(q: CopiesQuery): CopiesAnswer {
  const cap = Math.min(q.maxCopies ?? q.deckSize, q.deckSize);
  const at = (c: number): number => {
    if (c < q.needed) return 0;
    const curve = evaluate(q.deckSize, { A: c }, {
      clauses: [{ A: { lo: q.needed, hi: c } }], monotone: true,
    }).curve;
    return curve[Math.min(q.seen, curve.length - 1)] ?? 0;
  };

  // BINARY search, not linear. P is monotone in copies, so the first count reaching the
  // target is found in ~log2(cap) evaluations instead of up to `cap` of them. The linear
  // version cost 32ms per call at deck 99, and the card makes four calls per render --
  // enough to make typing visibly stutter on a phone.
  if (at(cap) < q.target) {
    return { copies: null, achieved: at(cap), achievedOneFewer: at(Math.max(q.needed, cap - 1)) };
  }
  let lo = q.needed;
  let hi = cap;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (at(mid) >= q.target) hi = mid; else lo = mid + 1;
  }
  return { copies: lo, achieved: at(lo), achievedOneFewer: lo > q.needed ? at(lo - 1) : 0 };
}
