import { describe, expect, it } from 'vitest';
import { validationRow, validationTable } from './validationReport';

describe('validation report format', () => {
  it('signs the error, so direction is never lost', () => {
    const over = validationRow({
      label: 'N=60 A=10/2 C=8xlook3 n=15', role: 'shape' as const, conditions: { deck: 60, groups: { A: 10 }, effect: 'scry' as const, look: 3, keep: 'all' as const, copies: 8, draws: 12 }, query: 'A>=2',
      reference: 'exact-dp', referenceValue: 0.33226, candidateValue: 0.34602,
      verdict: 'OUT OF BAR',
    });
    expect(over).toContain('**+1.376**');
    const under = validationRow({
      label: 'x', role: 'shape' as const, conditions: { deck: 60, groups: { A: 10 }, effect: 'scry' as const, look: 3, keep: 'all' as const, copies: 8, draws: 12 }, query: 'A>=2', reference: 'exact-dp', referenceValue: 0.5, candidateValue: 0.49,
      verdict: 'OUT OF BAR',
    });
    expect(under).toContain('**-1.000**');
  });

  it('surfaces a mass shortfall in the note, since the column is gone', () => {
    expect(validationRow({
      label: 'x', role: 'shape' as const, conditions: { deck: 60, groups: { A: 10 }, effect: 'scry' as const, look: 3, keep: 'all' as const, copies: 8, draws: 12 }, query: 'A>=2', reference: 'exact-dp', referenceValue: 1, candidateValue: 1,
      verdict: 'EXACT', mass: 0.9497,
    })).toContain('NOT A PARTITION');
    expect(validationRow({
      label: 'x', role: 'shape' as const, conditions: { deck: 60, groups: { A: 10 }, effect: 'scry' as const, look: 3, keep: 'all' as const, copies: 8, draws: 12 }, query: 'A>=2', reference: 'analytic', referenceValue: 1, candidateValue: 1, verdict: 'EXACT',
    })).not.toContain('NOT A PARTITION');
  });

  it('bolds an out-of-bar delta, since the verdict column is gone', () => {
    const out = validationRow({
      label: 'x', role: 'shape' as const,
      conditions: { deck: 60, groups: { A: 10 }, effect: 'scry' as const, look: 3, keep: 'all' as const, copies: 8, draws: 12 },
      query: 'A>=2', reference: 'exact-dp', referenceValue: 0.3, candidateValue: 0.315,
      verdict: 'OUT OF BAR',
    });
    expect(out).toContain('**+1.500**');
    const ok = validationRow({
      label: 'x', role: 'shape' as const,
      conditions: { deck: 60, groups: { A: 10 }, effect: 'scry' as const, look: 3, keep: 'all' as const, copies: 8, draws: 12 },
      query: 'A>=2', reference: 'exact-dp', referenceValue: 0.3, candidateValue: 0.3005,
      verdict: 'WITHIN BAR',
    });
    expect(ok).toContain('| +0.050 |');
    expect(ok).not.toContain('**+0.050**');
  });

  it('marks circular columns as not being evidence', () => {
    const row = validationRow({
      label: 'x', role: 'shape' as const, conditions: { deck: 60, groups: { A: 10 }, effect: 'scry' as const, look: 3, keep: 'all' as const, copies: 8, draws: 12 }, query: 'A>=2', reference: 'exact-dp', referenceValue: 0.3, candidateValue: 0.3,
      verdict: 'EXACT', circular: 'd*n/keeps = 2S holds by construction',
    });
    expect(row).toContain('CIRCULAR, not evidence');
  });

  it('surfaces the worst row rather than an average', () => {
    const table = validationTable('scry method', [
      { label: 'c=1', role: 'shape' as const, conditions: { deck: 60, groups: { A: 10 }, effect: 'scry' as const, look: 3, keep: 'all' as const, copies: 8, draws: 12 }, query: 'A>=2', reference: 'degenerate', referenceValue: 0.3, candidateValue: 0.3, verdict: 'EXACT' },
      { label: 'c=4', role: 'shape' as const, conditions: { deck: 60, groups: { A: 10 }, effect: 'scry' as const, look: 3, keep: 'all' as const, copies: 8, draws: 12 }, query: 'A>=2', reference: 'exact-dp', referenceValue: 0.3, candidateValue: 0.307, verdict: 'OUT OF BAR' },
      { label: 'c=8', role: 'shape' as const, conditions: { deck: 60, groups: { A: 10 }, effect: 'scry' as const, look: 3, keep: 'all' as const, copies: 8, draws: 12 }, query: 'A>=2', reference: 'exact-dp', referenceValue: 0.3, candidateValue: 0.314, verdict: 'OUT OF BAR' },
    ]);
    expect(table).toContain('WORST: c=8');
    expect(table).toContain('at +1.400pt');
  });

  it('flags a report with no degenerate row', () => {
    const table = validationTable('incomplete', [
      { label: 'c=8', role: 'shape' as const, conditions: { deck: 60, groups: { A: 10 }, effect: 'scry' as const, look: 3, keep: 'all' as const, copies: 8, draws: 12 }, query: 'A>=2', reference: 'exact-dp', referenceValue: 0.3, candidateValue: 0.314, verdict: 'OUT OF BAR' },
    ]);
    expect(table).toContain('MISSING: no degenerate row');
  });

  it('escapes pipes so an OR query cannot corrupt the table', () => {
    // `(A>=2) | (B>=2)` contains a literal cell separator; unescaped it splits
    // the row and shifts every column after it.
    const row = validationRow({
      label: 'OR case', role: 'shape' as const, conditions: { deck: 60, groups: { A: 10 }, effect: 'scry' as const, look: 3, keep: 'all' as const, copies: 8, draws: 12 }, query: '(A>=2 & brick<=0) | (B>=2 & brick<=0)',
      reference: 'exact-dp', referenceValue: 0.3, candidateValue: 0.31, verdict: 'OUT OF BAR',
    });
    expect(row).toContain('\\|');
    // column count must survive: 10 columns => 11 splits on an unescaped pipe
    const unescaped = row.split(/(?<!\\)\|/).length;
    expect(unescaped).toBe(13); // leading + 11 cells + trailing
  });

  it('refuses an empty report', () => {
    expect(() => validationTable('nothing', [])).toThrow();
  });
});
