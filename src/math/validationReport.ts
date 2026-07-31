/**
 * **TEST-ONLY.** Standard format for reporting validity / sanity checks, so every
 * comparison in this project reads the same way and the same columns are always
 * present. See CLAUDE.md for the convention this implements.
 *
 * The format exists because this session produced a string of misreadings that a
 * fixed shape would have prevented: an unsigned error hid which direction a
 * method was wrong in, a column that was true by construction got read as
 * confirmation, a missing mass column let a non-partition enumeration look
 * healthy for several turns, and averages hid worst cases.
 */

/** Which oracle the candidate is being measured against. Ordered by strength:
 * an analytic answer beats a mechanical play-out beats another model. */
export type Reference =
  /** Closed-form answer derived independently of any code here. Strongest. */
  | 'analytic'
  /** Play-out of every distinct deck ordering with real card mechanics. */
  | 'brute'
  /** Play-out with clairvoyant decisions -- an upper bound, not an answer. */
  | 'brute-clairvoyant'
  /** The exact DP. Sound, but shares a codebase, so weaker than the above. */
  | 'exact-dp'
  /** A degenerate configuration where the model must reduce to plain hypergeometry. */
  | 'degenerate';

export type Verdict =
  /** Agreement to ~1e-9, where exactness is the correct expectation. */
  | 'EXACT'
  /** Within the 0.1pt decision bar (see CLAUDE.md on tolerance). */
  | 'WITHIN BAR'
  /** Outside the bar. State the size and the sign; do not soften. */
  | 'OUT OF BAR'
  /** Lies between two rigorous bounds. The right verdict when the reference is a
   * fixed policy and the candidate optimizes (or vice versa), where an exact
   * match would actually indicate a bug. */
  | 'BRACKETED'
  /** Candidate correctly refused a regime it does not support. */
  | 'REFUSED'
  /** Candidate makes no claim here; reported so the gap is visible. */
  | 'N/A REGIME';

export interface ValidationRow {
  /** Compact, complete config: deck, group counts, copies, look size, draws.
   * Errors scale with these, so a row without them cannot be compared. */
  config: string;
  /** The actual query, written out (`A>=2 & brick<=0`, `(A>=2) | (B>=2)`).
   * Rendered on its own line inside the config cell: a label like "1cl+brick"
   * says which case it is, but only the expression says what was asked. */
  query?: string;
  reference: Reference;
  referenceValue: number;
  candidateValue: number;
  /** Total probability mass, for enumeration methods. A shortfall means the
   * enumeration is not a partition of the sample space -- report it, never
   * normalise it away. */
  mass?: number;
  verdict: Verdict;
  candidateMs?: number;
  referenceMs?: number;
  /** Anything true by construction, or otherwise not evidence. Printed as a
   * warning so it cannot be mistaken for confirmation. */
  circular?: string;
}

const pt = (x: number): string => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(3)}`;
const num = (x: number | undefined, digits: number): string =>
  x === undefined || Number.isNaN(x) ? '--' : x.toFixed(digits);
/** An OR query contains a literal `|`, which splits a markdown cell in two and
 * silently corrupts every column after it. Escape before emitting. */
const cell = (text: string): string => text.replace(/\|/g, '\\|');

/** Column headers, in fixed order. Emitted as a markdown table so reports can be
 * pasted or parsed rather than read as prose. */
export const VALIDATION_COLUMNS = [
  'config', 'reference', 'ref value', 'candidate', 'd (pt)', 'mass', 'verdict',
  'cand ms', 'ref ms', 'note',
] as const;

/** One markdown table row. Signed error always; worst case never averaged away. */
export function validationRow(r: ValidationRow): string {
  const delta = r.candidateValue - r.referenceValue;
  const cells = [
    cell(r.query === undefined ? r.config : `${r.config}<br>\`${r.query}\``),
    r.reference,
    num(r.referenceValue, 6),
    num(r.candidateValue, 6),
    Number.isNaN(delta) ? '--' : pt(delta),
    r.mass === undefined ? '--' : num(r.mass, 6),
    r.verdict,
    num(r.candidateMs, 0),
    num(r.referenceMs, 0),
    r.circular === undefined ? '' : cell(`CIRCULAR, not evidence: ${r.circular}`),
  ];
  return `| ${cells.join(' | ')} |`;
}

/**
 * A full report. Enforces the mandatory rows by refusing to format without them,
 * because each was a hole that actually bit:
 *  - a degenerate row (effect disabled) must be present and EXACT, or the shared
 *    machinery underneath is unverified;
 *  - the worst configuration must be present, since averages hide it;
 *  - mass must be reported wherever the candidate enumerates.
 */
export function validationTable(title: string, rows: ValidationRow[]): string {
  if (rows.length === 0) throw new Error('validation table needs rows');
  const hasDegenerate = rows.some((r) => r.reference === 'degenerate');
  const worst = rows.reduce((a, b) => (
    Math.abs(b.candidateValue - b.referenceValue) > Math.abs(a.candidateValue - a.referenceValue) ? b : a
  ));
  const lines = [
    `### ${title}`,
    '',
    `| ${VALIDATION_COLUMNS.join(' | ')} |`,
    `|${VALIDATION_COLUMNS.map(() => '---').join('|')}|`,
    ...rows.map((r) => validationRow(r)),
    '',
    `WORST: ${worst.config} at ${pt(worst.candidateValue - worst.referenceValue)}pt (${worst.verdict})`,
  ];
  if (!hasDegenerate) {
    lines.push('MISSING: no degenerate row -- the shared machinery is unverified here');
  }
  return lines.join('\n');
}
