import { expect, it } from 'vitest';
import { validationTable, type ValidationRow, type ValidationRole } from './validationReport';
import { triggerRecursion } from './triggerRecursion';
import { exactSelectionCurveDnf } from './selection';
import { evaluate } from './evaluate';

const scry = (S: number) => ({
  group: 'C', examined: S, keepMax: Infinity, keptCostsDraw: true, nonKeptLeavesPool: true,
});
const BAR = 0.001;

function run(
  label: string, role: ValidationRole, deck: number, A: number, need: number,
  copies: number, look: number, draws: number,
  opts: { swept?: ValidationRow['swept']; reference?: ValidationRow['reference'] } = {},
): ValidationRow {
  const t0 = performance.now();
  const ref = exactSelectionCurveDnf(deck, [A], [[{ lo: need }]], scry(look), copies, draws)[draws]!;
  const referenceMs = performance.now() - t0;
  const t1 = performance.now();
  const cand = triggerRecursion(deck, A, need, copies, look, draws);
  const candidateMs = performance.now() - t1;
  const d = Math.abs(cand.p - ref);
  return {
    label, role,
    ...(opts.swept === undefined ? {} : { swept: opts.swept }),
    conditions: {
      deck, groups: { A }, effect: copies === 0 ? 'none' : 'scry',
      look, keep: 'all', copies, draws,
    },
    query: `A>=${need}`,
    reference: opts.reference ?? 'exact-dp',
    referenceValue: ref,
    candidateValue: cand.p,
    verdict: d < 1e-9 ? 'EXACT' : d <= BAR ? 'WITHIN BAR' : 'OUT OF BAR',
    candidateMs, referenceMs,
  };
}

it('per-trigger recursion: standard validation report', () => {
  const rows: ValidationRow[] = [
    run('no copies', 'degenerate', 60, 10, 2, 0, 3, 12, { reference: 'degenerate' }),
    run('one copy', 'sweep', 60, 10, 2, 1, 3, 12, { swept: 'copies' }),
    run('many copies', 'sweep', 60, 10, 2, 8, 3, 12, { swept: 'copies' }),
    run('smallest look', 'sweep', 60, 10, 2, 8, 1, 12, { swept: 'look' }),
    run('largest look', 'sweep', 60, 10, 2, 8, 5, 12, { swept: 'look' }),
    run('fewest draws', 'sweep', 60, 10, 2, 8, 3, 6, { swept: 'draws' }),
    run('most draws', 'sweep', 60, 10, 2, 8, 3, 20, { swept: 'draws' }),
    run('small deck', 'sweep', 40, 8, 2, 6, 2, 10, { swept: 'deck' }),
    run('needs three', 'shape', 60, 10, 3, 8, 3, 15),
    run('needs one', 'shape', 40, 8, 1, 6, 4, 8),
  ];

  // Analytic oracle: stacked deck of scry-100s. P is the no-scry base rate while
  // draws <= needed, then exactly 1. The closed-form method REFUSES this regime
  // (its trigger inversion breaks once windows truncate); the recursion handles
  // truncation natively via w = min(look, pool).
  const deck = 20, pieces = 4, need = 2;
  const base = evaluate(deck, { A: pieces }, {
    clauses: [{ A: { lo: need, hi: pieces } }], monotone: true,
  }).curve;
  for (const [label, draws, expected] of [
    ['stacked deck, at threshold', need, base[need]!],
    ['stacked deck, above threshold', need + 1, 1],
    ['stacked deck, below threshold', need - 1, 0],
  ] as const) {
    const v = triggerRecursion(deck, pieces, need, deck - pieces, 100, draws).p;
    rows.push({
      label, role: 'oracle',
      conditions: {
        deck, groups: { A: pieces }, effect: 'scry', look: 100, keep: 'all',
        copies: deck - pieces, draws,
      },
      query: `A>=${need}`,
      reference: 'analytic', referenceValue: expected, candidateValue: v,
      verdict: Math.abs(v - expected) < 1e-9 ? 'EXACT' : 'OUT OF BAR',
    });
  }

  // Regimes this module does not claim, reported so the gap stays visible.
  for (const [label, query] of [
    ['upper bound (brick)', 'A>=2 & brick<=0'],
    ['OR of clauses', '(A>=2) | (B>=2)'],
    ['multiple effect types', 'A>=2'],
  ] as const) {
    rows.push({
      label, role: 'shape',
      conditions: { deck: 60, groups: { A: 10 }, effect: 'scry', look: 3, keep: 'all', copies: 8, draws: 15 },
      query,
      reference: 'exact-dp', referenceValue: NaN, candidateValue: NaN,
      verdict: 'N/A REGIME',
    });
  }

  console.log('\n' + validationTable('PER-TRIGGER RECURSION vs exact DP', rows));

  for (const r of rows) {
    if (r.verdict === 'N/A REGIME') continue;
    expect(r.verdict).toBe('EXACT');
  }
  // it must also be faster than the reference wherever the reference is not trivial
  const heavy = rows.filter((r) => (r.referenceMs ?? 0) > 30);
  expect(heavy.length).toBeGreaterThan(2);
  for (const r of heavy) expect(r.candidateMs!).toBeLessThan(r.referenceMs!);
}, 900000);
