import { describe, expect, it } from 'vitest';
import { sfAtLeast } from './hyper';
import { cardsSeen, minSources, sourceTable, EDH, SIXTY } from './manaSources';

describe('mana source requirements (spec stage 1)', () => {
  it('ANCHOR: 18 sources for one pip by turn 4 in EDH', () => {
    // From docs/manabase-spec.md, non-negotiable. Pins both minSources and the
    // hypergeometric layer underneath it.
    expect(cardsSeen(EDH, 4)).toBe(11);
    expect(minSources(99, cardsSeen(EDH, 4), 1, 0.9)).toBe(18);
    expect(sfAtLeast(99, 18, 11, 1)).toBeGreaterThan(0.903);
    expect(sfAtLeast(99, 18, 11, 1)).toBeLessThan(0.905);
    expect(sfAtLeast(99, 17, 11, 1)).toBeLessThan(0.9);
  });

  it('1v1 Commander needs 20 -- the spec says 19 and the spec is wrong', () => {
    // The spec's own reasoning is right (the starting player skips the turn-1 draw,
    // so seen(4) = 10) but its number is off by one. Verified independently with
    // plain products, sharing no code with hyper.ts:
    //   n=10, K=18 -> 0.879430
    //   n=10, K=19 -> 0.894315   still under 0.90
    //   n=10, K=20 -> 0.907526   first count that clears it
    // The multiplayer anchor of 18 is correct (0.903815, inside the spec's stated
    // 0.903-0.905 window), so the error is confined to the 1v1 remark.
    const oneOnOne = { ...EDH, drawsOnFirstTurn: false };
    expect(cardsSeen(oneOnOne, 4)).toBe(10);
    expect(minSources(99, cardsSeen(oneOnOne, 4), 1, 0.9)).toBe(20);
  });

  it('is monotone: more pips need more sources, later turns need fewer', () => {
    const s = (k: number, t: number) => minSources(99, cardsSeen(EDH, t), k, 0.9);
    expect(s(2, 4)).toBeGreaterThan(s(1, 4));
    expect(s(3, 4)).toBeGreaterThan(s(2, 4));
    expect(s(1, 6)).toBeLessThanOrEqual(s(1, 4));
  });

  it('a pip step costs far more than a turn step', () => {
    // Spec invariant: (k=2 vs k=1) > 3 x (T4 vs T6). Two pips is a structural
    // demand; one extra turn is a rounding error by comparison.
    const s = (k: number, t: number) => minSources(99, cardsSeen(EDH, t), k, 0.9);
    const pipStep = s(2, 4) - s(1, 4);
    const turnStep = s(1, 4) - s(1, 6);
    expect(pipStep).toBeGreaterThan(3 * turnStep);
  });

  it('returns Infinity only when genuinely unreachable', () => {
    // Unreachable means "not even with every card a source": more pips than cards seen.
    expect(minSources(99, 11, 12, 0.9)).toBe(Infinity);
    // NOT unreachable, though it looks it: four pips off seven cards is fine if most
    // of the deck produces that colour. 43 of 60, which is a real answer, not an error.
    expect(minSources(60, cardsSeen(SIXTY, 1), 4, 0.9)).toBe(43);
  });

  it('needs nothing for zero pips', () => {
    expect(minSources(99, 11, 0, 0.9)).toBe(0);
  });

  it('builds a table over pips and turns', () => {
    const rows = sourceTable(EDH, [1, 2], [3, 4]);
    expect(rows).toHaveLength(4);
    const one4 = rows.find((r) => r.k === 1 && r.turn === 4)!;
    expect(one4.sources).toBe(18);
    expect(one4.seen).toBe(11);
  });
});
