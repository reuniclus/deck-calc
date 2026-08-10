import { it } from 'vitest';
import { cardsSeen, minSources, EDH } from './manaSources';
it('the requirement surface over (pips, turn)', () => {
  const turns = [1, 2, 3, 4, 5, 6, 8, 10];
  console.log('pips |' + turns.map((t) => `  T${t}`.slice(-4)).join(''));
  for (const k of [1, 2, 3]) {
    const row = turns.map((t) => {
      const s = minSources(99, cardsSeen(EDH, t), k, 0.9);
      return (Number.isFinite(s) ? String(s) : '—').padStart(4);
    });
    console.log(`  ${k}  |${row.join('')}`);
  }
  console.log('\n(cards seen: ' + turns.map((t) => `T${t}=${cardsSeen(EDH, t)}`).join(' ') + ')');
});
