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

describe('mulligans (approximated as a smaller effective hand)', () => {
  it('reduces the effective opening hand by the mulligan count', () => {
    expect(effectiveOpeningHand(D)).toBe(7);
    expect(effectiveOpeningHand({ ...D, mulligans: 1 })).toBe(6);
    expect(effectiveOpeningHand({ ...D, mulligans: 3 })).toBe(4);
  });

  it('never goes negative even with more mulligans than the opening hand', () => {
    expect(effectiveOpeningHand({ ...D, mulligans: 99 })).toBe(0);
  });

  it('shifts cardsSeenByTurn by exactly the mulligan count, turn structure unchanged', () => {
    const cfg = { ...D, mulligans: 2 };
    expect(cardsSeenByTurn(0, cfg)).toBe(5);
    expect(cardsSeenByTurn(1, cfg)).toBe(5); // firstTurnDraw false: still no draw on turn 1
    expect(cardsSeenByTurn(2, cfg)).toBe(6);
    expect(cardsSeenByTurn(3, cfg)).toBe(7);
  });

  it('shifts turnForCardsSeen consistently with cardsSeenByTurn', () => {
    const cfg = { ...D, mulligans: 2 };
    for (let turn = 1; turn <= 8; turn++) {
      expect(turnForCardsSeen(cardsSeenByTurn(turn, cfg), cfg)).toBe(turn);
    }
    expect(turnForCardsSeen(4, cfg)).toBeNull(); // below the reduced hand of 5
  });

  it('zero mulligans is exactly the pre-mulligan behavior (default, non-breaking)', () => {
    for (let turn = 0; turn <= 8; turn++) {
      expect(cardsSeenByTurn(turn, { ...D, mulligans: 0 })).toBe(cardsSeenByTurn(turn, D));
    }
  });
});
