import { it } from 'vitest';
import { sfAtLeast } from './hyper';
import { cardsSeen, minSources, EDH } from './manaSources';

const pCast = (K: number, k: number, turn: number) => sfAtLeast(99, K, cardsSeen(EDH, turn), k);
const specFloor = (cs: Array<{ k: number; turn: number }>) =>
  Math.max(0, ...cs.map((c) => minSources(99, cardsSeen(EDH, c.turn), c.k, 0.9)));
/** fewest sources with E[cards not castable on time] <= budget */
function forExpectedStuck(cs: Array<{ k: number; turn: number }>, budget: number): number {
  for (let K = 0; K <= 99; K++) {
    const stuck = cs.reduce((a, c) => a + (1 - pCast(K, c.k, c.turn)), 0);
    if (stuck <= budget) return K;
  }
  return Infinity;
}

it('expected-stuck objective vs the max', () => {
  const cases: Array<[string, Array<{ k: number; turn: number }>]> = [
    ['1 fragile T2 + 20 easy T5', [{ k: 2, turn: 2 }, ...Array.from({ length: 20 }, () => ({ k: 1, turn: 5 }))]],
    ['all 21 easy T5', Array.from({ length: 21 }, () => ({ k: 1, turn: 5 }))],
    ['all 21 fragile T2', Array.from({ length: 21 }, () => ({ k: 2, turn: 2 }))],
    ['1 splash T1 + 20 at T6', [{ k: 1, turn: 1 }, ...Array.from({ length: 20 }, () => ({ k: 1, turn: 6 }))]],
    ['3 cards only, all T4 1pip', Array.from({ length: 3 }, () => ({ k: 1, turn: 4 }))],
  ];
  for (const [label, cs] of cases) {
    const f = specFloor(cs);
    const stuckAtFloor = cs.reduce((a, c) => a + (1 - pCast(f, c.k, c.turn)), 0);
    console.log(
      `${label}\n   spec max=${f} (E[stuck] there = ${stuckAtFloor.toFixed(2)} of ${cs.length})`
      + `  |  E[stuck]<=1 -> ${forExpectedStuck(cs, 1)}`
      + `  |  <=2 -> ${forExpectedStuck(cs, 2)}`,
    );
  }
});
