import { it } from 'vitest';
import { lands, padLibrary, type SimCard } from './handSim';
import { formatReport, manaReport } from './manaReport';
import { SACRED_BLINK_SPELLS, SACRED_BLINK_OFFLAND } from './sacredBlink.fixture';
// 38 lands: 6 tri/rainbow + 2 fetch + 1 Plains + 1 Island + 1 Forest + 1 colourless + 26 duals
const build = (wu: number, wg: number, ug: number): SimCard[] => padLibrary([
  ...lands(6, 'W', 'U', 'G'), ...lands(2, 'W', 'U', 'G'),
  ...lands(1, 'W'), ...lands(1, 'U'), ...lands(1, 'G'), ...lands(1),
  ...lands(wu, 'W', 'U'), ...lands(wg, 'W', 'G'), ...lands(ug, 'U', 'G'),
  ...SACRED_BLINK_OFFLAND, ...SACRED_BLINK_SPELLS,
]);
it('best split of 26 duals', () => {
  const combos: Array<[number, number, number]> = [];
  for (let wu = 0; wu <= 26; wu += 2) for (let wg = 0; wg + wu <= 26; wg += 2) combos.push([wu, wg, 26 - wu - wg]);
  const rows = manaReport(combos.map(([wu, wg, ug]) => ({
    label: `${wu}WU/${wg}WG/${ug}UG`, library: build(wu, wg, ug),
  })), { keepColour: 'G', minSources: 3, runs: 25000, seed: 8675309, lookaheads: [0] });
  const byCast = [...rows].sort((a, b) => b.castable - a.castable);
  console.log('TOP 6 BY CASTABILITY');
  console.log(formatReport(byCast.slice(0, 6)));
  const byThrown = [...rows].sort((a, b) => a.thrownForKeepColour - b.thrownForKeepColour);
  console.log('\nTOP 4 BY FEWEST GREEN-THROWS');
  console.log(formatReport(byThrown.slice(0, 4)));
}, 900000);
