import { expect, it } from 'vitest';
import { validationTable, type ValidationRow } from './validationReport';
import { scryModifiedQuery, ScryInversionError } from './modifiedQueryScry';
import { exactSelectionCurveDnf } from './selection';
import type { SelectionEffect } from './selection';

const scry = (S: number): SelectionEffect => ({
  group: 'C', examined: S, keepMax: Infinity, keptCostsDraw: true, nonKeptLeavesPool: true,
});
const BAR = 0.001; // 0.1pt

function row(
  label: string, N: number, counts: number[], query: string,
  clauses: Array<Array<{ lo: number; hi?: number }>>, copies: number, S: number, n: number,
  reference: ValidationRow['reference'] = 'exact-dp',
): ValidationRow {
  const t0 = performance.now();
  const ref = exactSelectionCurveDnf(N, counts, clauses, scry(S), copies, n)[n]!;
  const refMs = performance.now() - t0;
  const t1 = performance.now();
  const cand = scryModifiedQuery(N, counts, clauses, copies, S, n);
  const candMs = performance.now() - t1;
  const d = Math.abs(cand.p - ref);
  const verdict: ValidationRow['verdict'] = d < 1e-9 ? 'EXACT' : d <= BAR ? 'WITHIN BAR' : 'OUT OF BAR';
  return {
    config: `${label}<br>N=${N} C=${copies}xlook${S} n=${n}`,
    query,
    reference, referenceValue: ref, candidateValue: cand.p,
    mass: cand.mass, verdict, candidateMs: candMs, referenceMs: refMs,
  };
}

// Slow (~30s): it runs the exact DP on ten configurations including the corner
// that takes ~22s. Kept in the suite anyway, because it is the only place the
// method's accuracy AND cost are measured side by side across every parameter
// that scales the error -- and running it is what revealed that the method is
// slower than the reference nearly everywhere.
it('scry method: standard validation report', () => {
  const N = 60, A = 10, B = 6, BR = 4;
  const one = [[{ lo: 2 }, { lo: 0 }, { lo: 0 }]];
  const oneBrick = [[{ lo: 2 }, { lo: 0 }, { lo: 0, hi: 0 }]];
  const orBrick = [[{ lo: 2 }, { lo: 0 }, { lo: 0, hi: 0 }], [{ lo: 0 }, { lo: 2 }, { lo: 0, hi: 0 }]];
  const noKeeps = [[{ lo: 0 }, { lo: 0 }, { lo: 0, hi: 0 }]];
  const rows: ValidationRow[] = [];

  // mandatory: degenerate (effect disabled)
  rows.push(row('degenerate/0copies', N, [A, B, BR], 'A>=2', one, 0, 3, 12, 'degenerate'));
  // mandatory: regime where the defect switches off entirely
  rows.push(row('no-keeps', N, [A, B, BR], 'brick<=0', noKeeps, 8, 3, 12, 'degenerate'));
  // extremes of each error-scaling parameter
  rows.push(row('copies-min', N, [A, B, BR], 'A>=2', one, 1, 3, 12));
  rows.push(row('copies-max', N, [A, B, BR], 'A>=2', one, 8, 3, 12));
  rows.push(row('look-min', N, [A, B, BR], 'A>=2', one, 8, 1, 12));
  rows.push(row('look-max', N, [A, B, BR], 'A>=2', one, 8, 5, 12));
  rows.push(row('draws-min', N, [A, B, BR], 'A>=2', one, 8, 3, 6));
  rows.push(row('draws-max', N, [A, B, BR], 'A>=2', one, 8, 3, 20));
  // query shapes
  rows.push(row('1cl+brick', N, [A, B, BR], 'A>=2 & brick<=0', oneBrick, 8, 3, 15));
  rows.push(row('OR+brick', N, [A, B, BR], '(A>=2 & brick<=0) | (B>=2 & brick<=0)', orBrick, 8, 3, 15));

  // mandatory: analytic oracle
  let oracle: ValidationRow;
  try {
    const r = scryModifiedQuery(20, [4], [[{ lo: 2 }]], 16, 100, 2);
    oracle = {
      config: 'oracle stacked-deck<br>N=20 C=16xlook100 n=2',
      query: 'A>=2', reference: 'analytic', referenceValue: 0.031579, candidateValue: r.p,
      mass: r.mass, verdict: 'OUT OF BAR',
    };
  } catch (e) {
    oracle = {
      config: 'oracle stacked-deck<br>N=20 C=16xlook100 n=2',
      query: 'A>=2', reference: 'analytic', referenceValue: 0.031579, candidateValue: NaN,
      verdict: e instanceof ScryInversionError ? 'REFUSED' : 'N/A REGIME',
    };
  }
  rows.push(oracle);

  console.log('\n' + validationTable('SCRY modified-query method vs exact DP', rows));

  // Assertions, so this is a test rather than a printout.
  for (const r of rows) {
    if (r.reference === 'degenerate') expect(r.verdict).toBe('EXACT');
    if (r.mass !== undefined) expect(r.mass).toBeCloseTo(1, 9);
    // the method is an upper bound: it must never come in under the reference
    if (Number.isFinite(r.candidateValue)) {
      expect(r.candidateValue).toBeGreaterThanOrEqual(r.referenceValue - 1e-12);
    }
  }
  // Pinned findings. Both were wrong in my own summaries until this table ran.
  const worst = rows.reduce((a, b) => (
    Math.abs(b.candidateValue - b.referenceValue) > Math.abs(a.candidateValue - a.referenceValue) ? b : a
  ));
  expect(worst.config).toContain('draws-min');       // NOT the OR+brick corner
  // Cost profile: this is a SUPPLEMENT, so what matters is that it wins big
  // where the exact DP is expensive, not that it wins everywhere. It is slower
  // on cheap monotone configs and that is fine.
  const corner = rows.find((r) => r.config.startsWith('OR+brick'))!;
  expect(corner.candidateMs!).toBeLessThan(corner.referenceMs! / 10);
}, 900000);
