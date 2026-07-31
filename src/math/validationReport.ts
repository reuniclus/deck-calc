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

/** Why this row is in the table. Controlled vocabulary, because labels like
 * "look-min" told a reader nothing:
 *  - `degenerate`: a configuration where the model MUST reduce to something
 *    already trusted (no copies, nothing ever kept, keepMax >= look, need=1).
 *    These must come out EXACT; if one does not, the shared machinery is broken
 *    and nothing else in the table means anything.
 *  - `sweep`: one parameter pushed to an extreme, with `swept` naming which.
 *    Present because error scales with copies, look size and draw count, so a
 *    single mid-range configuration hides the worst case.
 *  - `shape`: a query STRUCTURE worth isolating (one clause, OR of clauses,
 *    with or without an upper bound), holding the numbers fixed.
 *  - `oracle`: an answer derived analytically, independent of all code here.
 */
export type ValidationRole = 'degenerate' | 'sweep' | 'shape' | 'oracle';

/** The initial conditions, structured rather than hand-formatted, so every row
 * states the same facts in the same order and none can be quietly omitted. */
export interface ValidationConditions {
  /** Cards in the deck. */
  deck: number;
  /** Tracked group -> copies in the deck. */
  groups: Record<string, number>;
  effect: 'none' | 'draw' | 'scry' | 'impulse' | 'ponder';
  /** Cards examined per cast. */
  look: number;
  /** Cards keepable per window; `'all'` means uncapped. */
  keep: number | 'all';
  /** Copies of the effect in the deck. */
  copies: number;
  /** Scheduled draws: opening hand plus draw steps. */
  draws: number;
}

/** Deck size and group composition -- its own column, since it is the thing most
 * often compared between rows. */
export function formatDeck(c: ValidationConditions): string {
  const groups = Object.entries(c.groups).map(([g, n]) => `${g}=${n}`).join(', ');
  return `deck=${c.deck}<br>${groups}`;
}

/** Effect configuration and draw budget -- its own column. */
export function formatEffect(c: ValidationConditions): string {
  if (c.effect === 'none') return `none<br>draws=${c.draws}`;
  return `${c.effect} look=${c.look}<br>keep=${c.keep} copies=${c.copies}<br>draws=${c.draws}`;
}

/** Both, on one line -- for the WORST summary line and anywhere a single string
 * is needed rather than table cells. */
export function formatConditions(c: ValidationConditions): string {
  const groups = Object.entries(c.groups).map(([g, n]) => `${g}=${n}`).join(',');
  const effect = c.effect === 'none'
    ? 'effect=none'
    : `effect=${c.effect} look=${c.look} keep=${c.keep} copies=${c.copies}`;
  return `deck=${c.deck} groups(${groups}) ${effect} draws=${c.draws}`;
}

export interface ValidationRow {
  /** Short human label for the case. */
  label: string;
  /** Why the row exists -- see `ValidationRole`. */
  role: ValidationRole;
  /** For `sweep` rows, which parameter is at an extreme. */
  swept?: 'copies' | 'look' | 'draws' | 'deck' | 'groups';
  /** Initial conditions, structured. */
  conditions: ValidationConditions;
  /** The query, written out: `A>=2 & brick<=0`, `(A>=2) | (B>=2)`. A label says
   * which case it is; only the expression says what was asked. */
  query: string;
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
  'case / role', 'deck & groups', 'effect & draws', 'query',
  'reference', 'ref value', 'candidate', 'd (pt)', 'cand ms', 'ref ms', 'note',
] as const;

/** One markdown table row. Signed error always; worst case never averaged away. */
export function validationRow(r: ValidationRow): string {
  const delta = r.candidateValue - r.referenceValue;
  const roleCell = r.role === 'sweep' && r.swept !== undefined ? `${r.role}:${r.swept}` : r.role;
  // `verdict` and `mass` are no longer columns, but neither is discarded: an
  // out-of-bar delta is bolded, and anything else that must not be missed is
  // pushed into the note. A mass shortfall in particular means the enumeration is
  // not a partition of the sample space, which is too serious to drop silently
  // just because the column is gone.
  const deltaCell = Number.isNaN(delta) ? '--'
    : r.verdict === 'OUT OF BAR' ? `**${pt(delta)}**` : pt(delta);
  const notes: string[] = [];
  if (r.verdict === 'REFUSED' || r.verdict === 'N/A REGIME') notes.push(r.verdict);
  if (r.mass !== undefined && Math.abs(r.mass - 1) > 1e-9) {
    notes.push(`mass=${num(r.mass, 6)} NOT A PARTITION`);
  }
  if (r.circular !== undefined) notes.push(`CIRCULAR, not evidence: ${r.circular}`);
  const cells = [
    cell(`**${r.label}**<br>${roleCell}`),
    cell(formatDeck(r.conditions)),
    cell(formatEffect(r.conditions)),
    cell(`\`${r.query}\``),
    r.reference,
    num(r.referenceValue, 6),
    num(r.candidateValue, 6),
    deltaCell,
    num(r.candidateMs, 0),
    num(r.referenceMs, 0),
    cell(notes.join('; ')),
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
  const missingRoles = (['degenerate', 'sweep', 'oracle'] as ValidationRole[])
    .filter((role) => !rows.some((r) => r.role === role));
  const lines = [
    `### ${title}`,
    '',
    `| ${VALIDATION_COLUMNS.join(' | ')} |`,
    `|${VALIDATION_COLUMNS.map(() => '---').join('|')}|`,
    ...rows.map((r) => validationRow(r)),
    '',
    `WORST: ${worst.label} (${formatConditions(worst.conditions)}) `
      + `at ${pt(worst.candidateValue - worst.referenceValue)}pt (${worst.verdict})`,
  ];
  if (!hasDegenerate) {
    lines.push('MISSING: no degenerate row -- the shared machinery is unverified here');
  }
  if (missingRoles.length > 0) {
    lines.push(`MISSING ROLES: ${missingRoles.join(', ')}`);
  }
  return lines.join('\n');
}
