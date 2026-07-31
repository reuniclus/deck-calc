import { expect, it } from 'vitest';
import { validationTable, type ValidationRow, type ValidationRole } from './validationReport';
import { scryModifiedQuery, ScryInversionError } from './modifiedQueryScry';
import { exactSelectionCurveDnf } from './selection';
import type { SelectionEffect } from './selection';

const scry = (S: number): SelectionEffect => ({
  group: 'C', examined: S, keepMax: Infinity, keptCostsDraw: true, nonKeptLeavesPool: true,
});
const BAR = 0.001; // 0.1pt -- see CLAUDE.md on tolerance

const N = 60, A = 10, B = 6, BR = 4;
const groups = { A, B, brick: BR };

function run(
  label: string, role: ValidationRole, query: string,
  clauses: Array<Array<{ lo: number; hi?: number }>>,
  copies: number, look: number, draws: number,
  opts: { swept?: ValidationRow['swept']; reference?: ValidationRow['reference'] } = {},
): ValidationRow {
  const t0 = performance.now();
  const ref = exactSelectionCurveDnf(N, [A, B, BR], clauses, scry(look), copies, draws)[draws]!;
  const referenceMs = performance.now() - t0;
  const t1 = performance.now();
  const cand = scryModifiedQuery(N, [A, B, BR], clauses, copies, look, draws);
  const candidateMs = performance.now() - t1;
  const d = Math.abs(cand.p - ref);
  return {
    label,
    role,
    ...(opts.swept === undefined ? {} : { swept: opts.swept }),
    conditions: {
      deck: N, groups, effect: copies === 0 ? 'none' : 'scry', look, keep: 'all', copies, draws,
    },
    query,
    reference: opts.reference ?? 'exact-dp',
    referenceValue: ref,
    candidateValue: cand.p,
    mass: cand.mass,
    verdict: d < 1e-9 ? 'EXACT' : d <= BAR ? 'WITHIN BAR' : 'OUT OF BAR',
    candidateMs,
    referenceMs,
  };
}

const monotone = [[{ lo: 2 }, { lo: 0 }, { lo: 0 }]];
const oneBrick = [[{ lo: 2 }, { lo: 0 }, { lo: 0, hi: 0 }]];
const orBrick = [[{ lo: 2 }, { lo: 0 }, { lo: 0, hi: 0 }], [{ lo: 0 }, { lo: 2 }, { lo: 0, hi: 0 }]];
const noNeeds = [[{ lo: 0 }, { lo: 0 }, { lo: 0, hi: 0 }]];

// Slow (~20s): runs the exact DP on eleven configurations including the corner
// that takes ~13s. Kept in the suite because it is the only place accuracy AND
// cost are measured together across every parameter that scales the error.
it('scry method: standard validation report', () => {
  const rows: ValidationRow[] = [
    run('no copies', 'degenerate', 'A>=2', monotone, 0, 3, 12, { reference: 'degenerate' }),
    run('nothing ever kept', 'degenerate', 'brick<=0', noNeeds, 8, 3, 12, { reference: 'degenerate' }),
    run('one copy', 'sweep', 'A>=2', monotone, 1, 3, 12, { swept: 'copies' }),
    run('many copies', 'sweep', 'A>=2', monotone, 8, 3, 12, { swept: 'copies' }),
    run('smallest look', 'sweep', 'A>=2', monotone, 8, 1, 12, { swept: 'look' }),
    run('largest look', 'sweep', 'A>=2', monotone, 8, 5, 12, { swept: 'look' }),
    run('fewest draws', 'sweep', 'A>=2', monotone, 8, 3, 6, { swept: 'draws' }),
    run('most draws', 'sweep', 'A>=2', monotone, 8, 3, 20, { swept: 'draws' }),
    run('one clause, upper bound', 'shape', 'A>=2 & brick<=0', oneBrick, 8, 3, 15),
    run('OR of clauses, upper bound', 'shape',
      '(A>=2 & brick<=0) | (B>=2 & brick<=0)', orBrick, 8, 3, 15),
  ];

  // Analytic oracle: fill every non-query slot with a scry-100. P is the no-scry
  // base rate while draws <= needed, then exactly 1. This method cannot compute
  // it -- the trigger inversion breaks once windows truncate -- so REFUSED is the
  // correct outcome, not a failure.
  const oracleDeck = 20, oraclePieces = 4, oracleNeed = 2;
  let oracleValue = NaN;
  let verdict: ValidationRow['verdict'] = 'REFUSED';
  try {
    oracleValue = scryModifiedQuery(
      oracleDeck, [oraclePieces], [[{ lo: oracleNeed }]], oracleDeck - oraclePieces, 100, oracleNeed,
    ).p;
    verdict = Math.abs(oracleValue - 0.031579) < BAR ? 'WITHIN BAR' : 'OUT OF BAR';
  } catch (e) {
    if (!(e instanceof ScryInversionError)) throw e;
  }
  rows.push({
    label: 'stacked deck, at threshold',
    role: 'oracle',
    conditions: {
      deck: oracleDeck, groups: { A: oraclePieces }, effect: 'scry',
      look: 100, keep: 'all', copies: oracleDeck - oraclePieces, draws: oracleNeed,
    },
    query: `A>=${oracleNeed}`,
    reference: 'analytic',
    referenceValue: 0.031579,
    candidateValue: oracleValue,
    verdict,
  });

  console.log('\n' + validationTable('SCRY modified-query method vs exact DP', rows));

  for (const r of rows) {
    if (r.role === 'degenerate') expect(r.verdict).toBe('EXACT');
    if (r.mass !== undefined) expect(r.mass).toBeCloseTo(1, 9);
    if (Number.isFinite(r.candidateValue)) {
      // Not a strict upper bound any more: since trigger-position conditioning
      // landed, low-copy rows can come in marginally UNDER (the position cap and
      // the fixed point overlap there). Bound both directions instead.
      expect(Math.abs(r.candidateValue - r.referenceValue) * 100).toBeLessThan(2.5);
    }
  }
  // Pinned: with trigger-position conditioning the worst case moved from the
  // fewest-draws sweep (+2.609pt before) to the OR corner (+1.302pt). Every row
  // improved; these two pins moved with it, which is legitimate movement rather
  // than regression.
  const worst = rows.reduce((a, b) => (
    Math.abs(b.candidateValue - b.referenceValue) > Math.abs(a.candidateValue - a.referenceValue) ? b : a
  ));
  expect(worst.label).toBe('OR of clauses, upper bound');
  expect(Math.abs(worst.candidateValue - worst.referenceValue) * 100).toBeLessThan(2.5);
  // Still a supplement: it must beat the exact DP where the DP is costly. The
  // margin shrank from ~40x to ~3x because the position loop sits inside the
  // window enumeration; hoisting it out is the obvious recovery.
  const corner = rows.find((r) => r.label === 'OR of clauses, upper bound')!;
  expect(corner.candidateMs!).toBeLessThan(corner.referenceMs! / 2);
  // One copy is EXACT, which is the invariant to defend: it has a single trigger,
  // so position conditioning is exact and the keep deduction must be zero.
  const oneCopy = rows.find((r) => r.label === 'one copy')!;
  expect(oneCopy.verdict).toBe('EXACT');
}, 900000);
