import { describe, it, expect } from 'vitest';
import { cardsSeenByTurn, turnForCardsSeen, effectiveOpeningHand, DEFAULT_TURN_CONFIG as D } from './turns';

describe('turns model', () => {
  it('opening hand is turn 0, before any draw', () => {
    expect(cardsSeenByTurn(0, D)).toBe(7);
  });

  it('firstTurnDraw false skips the turn-1 draw (default)', () => {
    expect(cardsSeenByTurn(1, D)).toBe(7);
    expect(cardsSeenByTurn(2, D)).toBe(8);
    expect(cardsSeenByTurn(3, D)).toBe(9);
  });

  it('firstTurnDraw true draws on turn 1', () => {
    const cfg = { ...D, firstTurnDraw: true };
    expect(cardsSeenByTurn(1, cfg)).toBe(8);
    expect(cardsSeenByTurn(2, cfg)).toBe(9);
  });

  it('respects drawsPerTurn > 1', () => {
    const cfg = { ...D, drawsPerTurn: 2 };
    expect(cardsSeenByTurn(1, cfg)).toBe(7);
    expect(cardsSeenByTurn(2, cfg)).toBe(9);
    expect(cardsSeenByTurn(3, cfg)).toBe(11);
  });

  it('is the exact inverse of turnForCardsSeen for turn >= 1', () => {
    // Turn 0 is cardsSeenByTurn's seed value for "opening hand, no turn yet" —
    // it is not itself a turn the inverse should ever produce.
    for (const cfg of [D, { ...D, firstTurnDraw: true }, { ...D, drawsPerTurn: 2 }]) {
      for (let turn = 1; turn <= 10; turn++) {
        const n = cardsSeenByTurn(turn, cfg);
        expect(turnForCardsSeen(n, cfg)).toBe(turn);
      }
    }
  });

  it('below the opening hand has no turn; at the opening hand size, turn 1 (no draw yet)', () => {
    expect(turnForCardsSeen(0, D)).toBeNull();
    expect(turnForCardsSeen(6, D)).toBeNull();
    expect(turnForCardsSeen(7, D)).toBe(1); // firstTurnDraw false: turn 1 has no draw yet
  });

  it('rounds down mid-turn when drawsPerTurn > 1', () => {
    const cfg = { ...D, drawsPerTurn: 2 };
    expect(turnForCardsSeen(8, cfg)).toBe(1); // one card into turn 2's draw
  });
});

describe('mulligans (no longer approximated here -- see src/math/mulligan.ts for the exact model)', () => {
  it('effectiveOpeningHand ignores mulligans entirely -- the kept hand is always full-size under the new exact model', () => {
    expect(effectiveOpeningHand(D)).toBe(7);
    expect(effectiveOpeningHand({ ...D, mulligans: 1 })).toBe(7);
    expect(effectiveOpeningHand({ ...D, mulligans: 3 })).toBe(7);
    expect(effectiveOpeningHand({ ...D, mulligans: 99 })).toBe(7);
  });

  it('cardsSeenByTurn and turnForCardsSeen are completely unaffected by mulligans now (by design -- the old flat-subtraction approximation used to shift these, which was itself part of what was wrong: it changed a MARKER POSITION without ever touching the actual probability)', () => {
    for (const mulligans of [0, 1, 2, 3]) {
      const cfg = { ...D, mulligans };
      for (let turn = 0; turn <= 8; turn++) {
        expect(cardsSeenByTurn(turn, cfg)).toBe(cardsSeenByTurn(turn, D));
      }
      for (let n = 0; n <= 15; n++) {
        expect(turnForCardsSeen(n, cfg)).toBe(turnForCardsSeen(n, D));
      }
    }
  });
});
