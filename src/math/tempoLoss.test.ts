import { describe, expect, it } from 'vitest';
import { tempoLoss, type CurveEntry } from './tempoLoss';

/** Generic EDH curve, ramp separated so its mana production is modelled. */
const CURVE: CurveEntry[] = [
  { mv: 1, count: 4 }, { mv: 2, count: 14 }, { mv: 3, count: 16 },
  { mv: 4, count: 8 }, { mv: 5, count: 6 }, { mv: 6, count: 3 },
  { mv: 1, count: 1, produces: 2 },  // Sol Ring
  { mv: 2, count: 4, produces: 1 },  // signets
];
const run = (tapped: number, over: Partial<Parameters<typeof tempoLoss>[0]> = {}) =>
  tempoLoss({ lands: 38, tapped, curve: CURVE, runs: 20000, seed: 999, ...over });

describe('tempo loss from tapped lands', () => {
  it('is exactly zero with no tapped lands', () => {
    // The paired construction guarantees this: both worlds are identical, so any
    // non-zero result would mean the two play-outs diverge for a reason other than
    // tappedness -- a bug detector, not a fact about magic.
    const r = run(0);
    expect(r.loss).toBe(0);
    expect(r.freeGames).toBe(1);
  }, 60000);

  it('grows monotonically and roughly linearly', () => {
    const points = [4, 8, 12, 16, 20].map((t) => run(t).loss);
    for (let i = 1; i < points.length; i++) expect(points[i]!).toBeGreaterThan(points[i - 1]!);
    // ~0.09 mana per tapped land over six turns, near-linear rather than threshold-like
    const perLand = points.map((p, i) => p / [4, 8, 12, 16, 20][i]!);
    for (const x of perLand) expect(x).toBeGreaterThan(0.07);
    for (const x of perLand) expect(x).toBeLessThan(0.11);
  }, 120000);

  it('pairing keeps the error far below the effect', () => {
    // Why paired sampling was worth the trouble: comparing two independent runs would
    // have a standard error comparable to the effect being measured.
    const r = run(12);
    expect(r.stderr).toBeLessThan(r.loss / 20);
  }, 60000);

  it('costs nothing in most games at low tapped counts', () => {
    // Slack absorbs them: a turn with no play is a free slot for a tapland.
    expect(run(4).freeGames).toBeGreaterThan(0.8);
    expect(run(16).freeGames).toBeGreaterThan(0.45);
  }, 120000);

  it('the EXPENSIVE curve suffers more, not the cheap one', () => {
    // Counterintuitive and worth pinning. A deck of one- and two-drops exhausts what it
    // can cast by about turn three and has surplus mana afterwards, which absorbs
    // taplands; a deck of five- and six-drops is mana-hungry every turn, so each tapped
    // land directly delays a spell. Measured 0.09 against 1.95 at sixteen taplands.
    //
    // So the thing that determines tapland pain is not cheapness but whether the deck
    // can CONSUME all its mana. A cheap deck with heavy card draw would behave like the
    // expensive one here.
    const cheap: CurveEntry[] = [{ mv: 1, count: 20 }, { mv: 2, count: 20 }];
    const expensive: CurveEntry[] = [{ mv: 5, count: 20 }, { mv: 6, count: 20 }];
    const a = tempoLoss({ lands: 38, tapped: 16, curve: cheap, runs: 20000, seed: 7 });
    const b = tempoLoss({ lands: 38, tapped: 16, curve: expensive, runs: 20000, seed: 7 });
    expect(b.loss).toBeGreaterThan(a.loss * 5);
  }, 120000);
});
