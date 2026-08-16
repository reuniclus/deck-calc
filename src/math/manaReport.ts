/**
 * Standard manabase report: the same columns every time, so runs are comparable.
 *
 * Reports BOTH frames because they disagree and the disagreement is informative:
 *  - the opening seven, which is what the mulligan decision actually sees;
 *  - seven plus draws, keeping the mulligan judged on the opener alone.
 *
 * And it reports `fractionCastable` rather than "every card castable". Cards are played
 * on different turns, so each only needs its OWN pips payable; requiring all of them at
 * once gets harder the more you draw, which made a ten-card frame score below a
 * seven-card one for the same manabase. That was a bug in the metric, not a finding.
 *
 * The two headline numbers usually rank splits differently -- Forests cut mulligans while
 * Plains and Islands raise castability of what is kept -- so both are printed rather than
 * blended into one score that hides the trade.
 */
import { firstHandQuality, type SimCard } from './handSim';

export interface ReportRow {
  label: string;
  cardsSeen: number;
  /** Mean share of coloured cards held that are individually castable. */
  castable: number;
  /** Share of hands where one more source of each colour would have helped. */
  short: Record<string, number>;
  /** Colour short in the most hands. */
  worstColour: string;
  /** Castable hands mulliganed purely for lacking the keep colour. */
  thrownForKeepColour: number;
  /** Hands excluded as mana screw. */
  screwed: number;
}

export interface ReportOptions {
  keepColour: string;
  minSources?: number;
  runs?: number;
  seed?: number;
  /** Extra draws after the keep decision. Each entry produces its own row. */
  lookaheads?: number[];
  colours?: string[];
}

export function manaReport(
  entries: Array<{ label: string; library: SimCard[] }>,
  opts: ReportOptions,
): ReportRow[] {
  const looks = opts.lookaheads ?? [0, 3];
  const colours = opts.colours ?? ['W', 'U', 'G'];
  const rows: ReportRow[] = [];
  for (const { label, library } of entries) {
    for (const lookahead of looks) {
      const r = firstHandQuality(library, {
        keepColour: opts.keepColour,
        minSources: opts.minSources ?? 3,
        runs: opts.runs ?? 60000,
        seed: opts.seed ?? 8675309,
        lookahead,
      });
      const short: Record<string, number> = {};
      for (const c of colours) short[c] = r.missing[c] ?? 0;
      const worst = colours.reduce((a, c) => ((short[c] ?? 0) > (short[a] ?? 0) ? c : a), colours[0]!);
      rows.push({
        label,
        cardsSeen: r.cardsSeen,
        castable: r.fractionCastable,
        short,
        worstColour: worst,
        thrownForKeepColour: r.thrownForKeepColour,
        screwed: r.screwed,
      });
    }
  }
  return rows;
}

/** Fixed-width text table, so two runs can be diffed by eye. */
export function formatReport(rows: ReportRow[], colours = ['W', 'U', 'G']): string {
  const head = `${'composition'.padEnd(20)} | see | castable | ${colours.map((c) => `short ${c}`).join(' ')} | worst | thrown | screw`;
  const lines = [head, '-'.repeat(head.length)];
  for (const r of rows) {
    lines.push(
      `${r.label.padEnd(20)} | ${String(r.cardsSeen).padStart(3)} | ${(r.castable * 100).toFixed(1).padStart(7)}% `
      + `| ${colours.map((c) => `${((r.short[c] ?? 0) * 100).toFixed(1).padStart(6)}%`).join(' ')} `
      + `| ${r.worstColour.padEnd(5)} | ${(r.thrownForKeepColour * 100).toFixed(2).padStart(5)}% `
      + `| ${(r.screwed * 100).toFixed(1).padStart(4)}%`,
    );
  }
  return lines.join('\n');
}
