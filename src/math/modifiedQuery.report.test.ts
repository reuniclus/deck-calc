import { expect, it } from 'vitest';
import { validationTable, type ValidationRow } from './validationReport';
import { modifiedQueryUpperBound } from './modifiedQuery';
import { exactSelectionCurveDnf, impulseEffect } from './selection';

const BAR = 0.001; // 0.1pt

function row(
  label: string, N: number, counts: number[], query: string,
  clauses: Array<Array<{ lo: number; hi?: number }>>, copies: number, E: number, K: number, n: number,
  reference: ValidationRow['reference'] = 'exact-dp',
): ValidationRow {
  const t0 = performance.now();
  const ref = exactSelectionCurveDnf(N, counts, clauses, { ...impulseEffect('C', E), keepMax: K }, copies, n)[n]!;
  const refMs = performance.now() - t0;
  const t1 = performance.now();
  const cand = modifiedQueryUpperBound(N, counts, clauses, copies, E, K, n);
  const candMs = performance.now() - t1;
  const d = Math.abs(cand - ref);
  const verdict: ValidationRow['verdict'] = d < 1e-9 ? 'EXACT' : d <= BAR ? 'WITHIN BAR' : 'OUT OF BAR';
  return {
    config: `${label}<br>N=${N} C=${copies}xlook${E}keep${K} n=${n}`,
    query,
    reference, referenceValue: ref, candidateValue: cand,
    verdict, candidateMs: candMs, referenceMs: refMs,
  };
}

it('impulse method: standard validation report', () => {
  const N = 60, A = 10, B = 6, BR = 4;
  const one = [[{ lo: 2 }, { lo: 0 }, { lo: 0 }]];
  const oneBrick = [[{ lo: 2 }, { lo: 0 }, { lo: 0, hi: 0 }]];
  const orBrick = [[{ lo: 2 }, { lo: 0 }, { lo: 0, hi: 0 }], [{ lo: 0 }, { lo: 2 }, { lo: 0, hi: 0 }]];
  const need1 = [[{ lo: 1 }, { lo: 0 }, { lo: 0 }]];
  const rows: ValidationRow[] = [];

  rows.push(row('degenerate/0copies', N, [A, B, BR], 'A>=2', one, 0, 3, 1, 12, 'degenerate'));
  // keepMax >= look size: no card is ever ditched, so it must be exact
  rows.push(row('no-ditch/keep=look', N, [A, B, BR], 'A>=2', one, 8, 3, 3, 12, 'degenerate'));
  // need=1: never more than one missing piece, so impulse == draw exactly
  rows.push(row('need1', N, [A, B, BR], 'A>=1', need1, 8, 4, 1, 12, 'degenerate'));
  rows.push(row('copies-min', N, [A, B, BR], 'A>=2', one, 1, 3, 1, 12));
  rows.push(row('copies-max', N, [A, B, BR], 'A>=2', one, 8, 3, 1, 12));
  rows.push(row('look-min', N, [A, B, BR], 'A>=2', one, 8, 2, 1, 12));
  rows.push(row('look-max', N, [A, B, BR], 'A>=2', one, 8, 5, 1, 12));
  rows.push(row('draws-min', N, [A, B, BR], 'A>=2', one, 8, 3, 1, 6));
  rows.push(row('draws-max', N, [A, B, BR], 'A>=2', one, 8, 3, 1, 20));
  rows.push(row('1cl+brick', N, [A, B, BR], 'A>=2 & brick<=0', oneBrick, 8, 3, 1, 15));
  rows.push(row('OR+brick', N, [A, B, BR], '(A>=2 & brick<=0) | (B>=2 & brick<=0)', orBrick, 8, 3, 1, 15));

  // analytic oracle: impulse keeps are FREE (straight to hand), so with unlimited
  // look every cast yields one chosen piece -- P = 0 below the needed count and
  // exactly 1 at or above it. Distinct from scry's oracle, which needs T+1 draws
  // because scry keeps cost a draw to collect.
  const deck = 20, pieces = 4, need = 2;
  let oracle: ValidationRow;
  try {
    const v = modifiedQueryUpperBound(deck, [pieces], [[{ lo: need }]], deck - pieces, 100, 1, need);
    oracle = {
      config: `oracle impulse-100 at threshold<br>N=${deck} C=${deck - pieces}xlook100keep1 n=${need}`,
      query: `A>=${need}`, reference: 'analytic', referenceValue: 1, candidateValue: v,
      verdict: Math.abs(v - 1) < 1e-9 ? 'EXACT' : 'OUT OF BAR',
    };
  } catch {
    oracle = {
      config: `oracle impulse-100 at threshold<br>N=${deck} C=${deck - pieces}xlook100keep1 n=${need}`,
      query: `A>=${need}`, reference: 'analytic', referenceValue: 1, candidateValue: NaN, verdict: 'REFUSED',
    };
  }
  rows.push(oracle);

  // The row above does not discriminate: the true answer is 1.0, and a broken
  // trigger inversion also returns 1.0 (exactly how the scry variant's bug hid).
  // Below the threshold the answer is 0, so this row can actually fail.
  let oracleBelow: ValidationRow;
  try {
    const v = modifiedQueryUpperBound(deck, [pieces], [[{ lo: need }]], deck - pieces, 100, 1, need - 1);
    oracleBelow = {
      config: `oracle impulse-100 below threshold<br>N=${deck} C=${deck - pieces}xlook100keep1 n=${need - 1}`,
      query: `A>=${need}`, reference: 'analytic', referenceValue: 0, candidateValue: v,
      verdict: Math.abs(v) < 1e-9 ? 'EXACT' : 'OUT OF BAR',
    };
  } catch {
    oracleBelow = {
      config: `oracle impulse-100 below threshold<br>N=${deck} C=${deck - pieces}xlook100keep1 n=${need - 1}`,
      query: `A>=${need}`, reference: 'analytic', referenceValue: 0, candidateValue: NaN, verdict: 'REFUSED',
    };
  }
  rows.push(oracleBelow);

  console.log('\n' + validationTable('IMPULSE modified-query method vs exact DP', rows));

  for (const r of rows) {
    if (r.reference === 'degenerate') expect(r.verdict).toBe('EXACT');
    if (Number.isFinite(r.candidateValue)) {
      expect(r.candidateValue).toBeGreaterThanOrEqual(r.referenceValue - 1e-12);
    }
  }
}, 900000);
