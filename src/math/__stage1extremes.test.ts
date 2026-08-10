import { it } from 'vitest';
import { cardsSeen, minSources, EDH } from './manaSources';

// what the spec's stage 1 would emit: the max over cards of that colour
function specFloor(cards: Array<{ k: number; turn: number }>): number {
  return Math.max(0, ...cards.map((c) => minSources(99, cardsSeen(EDH, c.turn), c.k, 0.9)));
}
// a quantile alternative: cover all but the single worst card
function coverAllBut(cards: Array<{ k: number; turn: number }>, drop: number): number {
  const sorted = cards.map((c) => minSources(99, cardsSeen(EDH, c.turn), c.k, 0.9)).sort((a, b) => b - a);
  return sorted[drop] ?? 0;
}

it('extreme cases for the max-over-cards floor', () => {
  const cases: Array<[string, Array<{ k: number; turn: number }>]> = [
    ['1 fragile early card ({W}{W} T2) + 20 easy ({W} T5)',
      [{ k: 2, turn: 2 }, ...Array.from({ length: 20 }, () => ({ k: 1, turn: 5 }))]],
    ['all 21 easy ({W} T5)', Array.from({ length: 21 }, () => ({ k: 1, turn: 5 }))],
    ['all 21 fragile ({W}{W} T2)', Array.from({ length: 21 }, () => ({ k: 2, turn: 2 }))],
    ['one T1 splash ({U} T1) + 20 U at T6',
      [{ k: 1, turn: 1 }, ...Array.from({ length: 20 }, () => ({ k: 1, turn: 6 }))]],
    ['20 cards @1 pip T4 (same total pips as next)',
      Array.from({ length: 20 }, () => ({ k: 1, turn: 4 }))],
    ['10 cards @2 pips T4 (same total pips as prev)',
      Array.from({ length: 10 }, () => ({ k: 2, turn: 4 }))],
  ];
  for (const [label, cards] of cases) {
    const floor = specFloor(cards);
    const minus1 = coverAllBut(cards, 1);
    console.log(`${floor.toString().padStart(3)} sources | drop worst -> ${minus1.toString().padStart(3)} | ${label}`);
  }
});
