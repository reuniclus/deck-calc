import { expect, it } from 'vitest';
import { validationTable, type ValidationRow, type ValidationRole } from './validationReport';
import { modifiedQueryUpperBound } from './modifiedQuery';
import { exactSelectionCurveDnf, impulseEffect } from './selection';

const BAR = 0.001;
const N = 60, A = 10, B = 6, BR = 4;
const groups = { A, B, brick: BR };

function run(
  label: string, role: ValidationRole, query: string,
  clauses: Array<Array<{ lo: number; hi?: number }>>,
  copies: number, look: number, keep: number, draws: number,
  opts: { swept?: ValidationRow['swept']; reference?: ValidationRow['reference'] } = {},
): ValidationRow {
  const effect = { ...impulseEffect('C', look), keepMax: keep };
  const t0 = performance.now();
  const ref = exactSelectionCurveDnf(N, [A, B, BR], clauses, effect, copies, draws)[draws]!;
  const referenceMs = performance.now() - t0;
  const t1 = performance.now();
  const cand = modifiedQueryUpperBound(N, [A, B, BR], clauses, copies, look, keep, draws);
  const candidateMs = performance.now() - t1;
  const d = Math.abs(cand - ref);
  return {
    label,
    role,
    ...(opts.swept === undefined ? {} : { swept: opts.swept }),
    conditions: {
      deck: N, groups, effect: copies === 0 ? 'none' : 'impulse', look, keep, copies, draws,
    },
    query,
    reference: opts.reference ?? 'exact-dp',
    referenceValue: ref,
    candidateValue: cand,
    verdict: d < 1e-9 ? 'EXACT' : d <= BAR ? 'WITHIN BAR' : 'OUT OF BAR',
    candidateMs,
    referenceMs,
  };
}

const monotone = [[{ lo: 2 }, { lo: 0 }, { lo: 0 }]];
const need1 = [[{ lo: 1 }, { lo: 0 }, { lo: 0 }]];
const oneBrick = [[{ lo: 2 }, { lo: 0 }, { lo: 0, hi: 0 }]];
const orBrick = [[{ lo: 2 }, { lo: 0 }, { lo: 0, hi: 0 }], [{ lo: 0 }, { lo: 2 }, { lo: 0, hi: 0 }]];

it('impulse method: standard validation report', () => {
  const rows: ValidationRow[] = [
    run('no copies', 'degenerate', 'A>=2', monotone, 0, 3, 1, 12, { reference: 'degenerate' }),
    run('keep >= look (nothing ditched)', 'degenerate', 'A>=2', monotone, 8, 3, 3, 12, { reference: 'degenerate' }),
    run('needs only one', 'degenerate', 'A>=1', need1, 8, 4, 1, 12, { reference: 'degenerate' }),
    run('one copy', 'sweep', 'A>=2', monotone, 1, 3, 1, 12, { swept: 'copies' }),
    run('many copies', 'sweep', 'A>=2', monotone, 8, 3, 1, 12, { swept: 'copies' }),
    run('smallest look', 'sweep', 'A>=2', monotone, 8, 2, 1, 12, { swept: 'look' }),
    run('largest look', 'sweep', 'A>=2', monotone, 8, 5, 1, 12, { swept: 'look' }),
    run('fewest draws', 'sweep', 'A>=2', monotone, 8, 3, 1, 6, { swept: 'draws' }),
    run('most draws', 'sweep', 'A>=2', monotone, 8, 3, 1, 20, { swept: 'draws' }),
    run('one clause, upper bound', 'shape', 'A>=2 & brick<=0', oneBrick, 8, 3, 1, 15),
    run('OR of clauses, upper bound', 'shape', '(A>=2 & brick<=0) | (B>=2 & brick<=0)', orBrick, 8, 3, 1, 15),
  ];

  // Analytic oracles. Impulse keeps are FREE (straight to hand), so with unlimited
  // look each cast yields one chosen piece: P is 0 below the needed count and
  // exactly 1 at or above it. Scry needs T+1 instead, because its keeps cost a
  // draw to collect. The at-threshold row alone cannot discriminate -- 1.0 is also
  // what a broken trigger inversion returns -- so the below-threshold row, where
  // the answer is 0, is what gives this teeth.
  const deck = 20, pieces = 4, need = 2;
  for (const [label, draws, expected] of [
    ['stacked deck, at threshold', need, 1],
    ['stacked deck, below threshold', need - 1, 0],
  ] as const) {
    const v = modifiedQueryUpperBound(deck, [pieces], [[{ lo: need }]], deck - pieces, 100, 1, draws);
    rows.push({
      label,
      role: 'oracle',
      conditions: {
        deck, groups: { A: pieces }, effect: 'impulse',
        look: 100, keep: 1, copies: deck - pieces, draws,
      },
      query: `A>=${need}`,
      reference: 'analytic',
      referenceValue: expected,
      candidateValue: v,
      verdict: Math.abs(v - expected) < 1e-9 ? 'EXACT' : 'OUT OF BAR',
    });
  }

  console.log('\n' + validationTable('IMPULSE modified-query method vs exact DP', rows));

  for (const r of rows) {
    if (r.role === 'degenerate' || r.role === 'oracle') expect(r.verdict).toBe('EXACT');
    if (Number.isFinite(r.candidateValue)) {
      expect(r.candidateValue).toBeGreaterThanOrEqual(r.referenceValue - 1e-12);
    }
  }
  // Pinned: in bar only on bounded queries and long horizons, NOT generally.
  const bounded = rows.filter((r) => r.query.includes('brick<=0') && r.role === 'shape');
  for (const r of bounded) expect(r.verdict).toBe('WITHIN BAR');
  const worst = rows.reduce((a, b) => (
    Math.abs(b.candidateValue - b.referenceValue) > Math.abs(a.candidateValue - a.referenceValue) ? b : a
  ));
  expect(worst.label).toBe('fewest draws');
}, 900000);
