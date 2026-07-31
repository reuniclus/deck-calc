import { describe, expect, it } from 'vitest';
import { validationRow, validationTable } from './validationReport';

describe('validation report format', () => {
  it('signs the error, so direction is never lost', () => {
    const over = validationRow({
      config: 'N=60 A=10/2 C=8xlook3 n=15',
      reference: 'exact-dp', referenceValue: 0.33226, candidateValue: 0.34602,
      verdict: 'OUT OF BAR',
    });
    expect(over).toContain('| +1.376 |');
    const under = validationRow({
      config: 'x', reference: 'exact-dp', referenceValue: 0.5, candidateValue: 0.49,
      verdict: 'OUT OF BAR',
    });
    expect(under).toContain('| -1.000 |');
  });

  it('reports mass explicitly, including when absent', () => {
    expect(validationRow({
      config: 'x', reference: 'exact-dp', referenceValue: 1, candidateValue: 1,
      verdict: 'EXACT', mass: 0.9497,
    })).toContain('| 0.949700 |');
    expect(validationRow({
      config: 'x', reference: 'analytic', referenceValue: 1, candidateValue: 1, verdict: 'EXACT',
    })).toMatch(/\| -- \|/);
  });

  it('marks circular columns as not being evidence', () => {
    const row = validationRow({
      config: 'x', reference: 'exact-dp', referenceValue: 0.3, candidateValue: 0.3,
      verdict: 'EXACT', circular: 'd*n/keeps = 2S holds by construction',
    });
    expect(row).toContain('CIRCULAR, not evidence');
  });

  it('surfaces the worst row rather than an average', () => {
    const table = validationTable('scry method', [
      { config: 'c=1', reference: 'degenerate', referenceValue: 0.3, candidateValue: 0.3, verdict: 'EXACT' },
      { config: 'c=4', reference: 'exact-dp', referenceValue: 0.3, candidateValue: 0.307, verdict: 'OUT OF BAR' },
      { config: 'c=8', reference: 'exact-dp', referenceValue: 0.3, candidateValue: 0.314, verdict: 'OUT OF BAR' },
    ]);
    expect(table).toContain('WORST: c=8 at +1.400pt');
  });

  it('flags a report with no degenerate row', () => {
    const table = validationTable('incomplete', [
      { config: 'c=8', reference: 'exact-dp', referenceValue: 0.3, candidateValue: 0.314, verdict: 'OUT OF BAR' },
    ]);
    expect(table).toContain('MISSING: no degenerate row');
  });

  it('refuses an empty report', () => {
    expect(() => validationTable('nothing', [])).toThrow();
  });
});
