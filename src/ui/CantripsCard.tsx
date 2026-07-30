/**
 * "How many cantrips should I run" -- see PLAN.md's cantrip backlog section
 * for the full design history (why marginal values instead of a single
 * prescribed "optimal" mix, the dilution model, the shared-goal decision).
 *
 * No dilution picker: an earlier version asked the user to choose which
 * group absorbs dilution, but that was never part of the agreed design and
 * added a decision the tool can make itself. "Whichever group has the most
 * copies" is usually right (a well-stocked group already has a high
 * per-copy hit rate, so losing one hurts least) but not ALWAYS -- an OR
 * query like "A>=3 OR B>=1" can make the more-populous group the actual
 * bottleneck. Since candidate groups are always few and evaluate() is
 * cheap, bestDilutionChoice just tries every candidate directly instead of
 * guessing -- confirmed with a real counterexample where the naive
 * heuristic would have picked measurably worse (see cantrips.test.ts).
 *
 * Local component state only (not global app state, not URL-shared) --
 * this is exploratory scratch space for the Questions tab, not something
 * that needs to persist across sessions or be part of a shared link, same
 * treatment as target%/turn already get.
 */
import { useState } from 'react';
import { useAppState } from '../state/AppState';
import { useQueryModelCtx } from '../state/useQueryModel';
import { cardsSeenByTurn } from '../model/turns';
import {
  cantripSuccessRate, marginalValuePerCopyAutoDilute, copiesNeededForTargetAutoDilute,
  successGivenDrawnVsNot, bestDilutionChoice,
} from '../math/cantrips';
import { parseNumOr0 } from './numberInput';

function pct(p: number): string {
  return `${(p * 100).toFixed(0)}%`;
}

interface EffectType {
  name: string;
  bonus: number;
}

interface MixRow {
  count: number;
  bonus: number;
}

const DEFAULT_EFFECTS: EffectType[] = [
  { name: 'Draw 1', bonus: 1 },
  { name: 'See 3, pick 1', bonus: 3 },
  { name: 'Draw 2', bonus: 2 },
];

export function CantripsCard() {
  const { groups, deckSize, target, adviseTurn, turnCfg } = useAppState();
  const { dnf, sizes } = useQueryModelCtx();
  const [effects, setEffects] = useState<EffectType[]>(DEFAULT_EFFECTS);
  const [mix, setMix] = useState<MixRow[]>([{ count: 6, bonus: 3 }, { count: 1, bonus: 4 }]);
  const [showBuilder, setShowBuilder] = useState(false);

  if (!dnf) return <p className="hint">Fix the combo query above to see cantrip analysis.</p>;
  if (groups.length === 0) return <p className="hint">Add a group first.</p>;

  const othersCount = deckSize - groups.reduce((s, g) => s + g.count, 0);
  const cardsSeenByT = cardsSeenByTurn(adviseTurn, turnCfg);
  const groupIds = groups.map((g) => g.id);

  const marginalRows = effects.map((e, i) => {
    const marginal = marginalValuePerCopyAutoDilute(dnf, sizes, deckSize, cardsSeenByT, othersCount, groupIds, e.bonus);
    const needed = copiesNeededForTargetAutoDilute(dnf, sizes, deckSize, cardsSeenByT, othersCount, groupIds, e.bonus, target, deckSize);
    return { i, name: e.name, bonus: e.bonus, marginal, needed };
  });

  // A random n-card look at the CURRENT deck -- a fact about deck
  // composition in general, not about any specific mix, so it lives
  // outside the collapsible builder.
  const lookSize = 3;
  const lookComposition = groups.map((g) => ({ name: g.name, pct: g.count / deckSize }));
  const otherPct = Math.max(0, 1 - lookComposition.reduce((s, g) => s + g.pct, 0));

  const activeMix = mix.filter((m) => m.count > 0);
  const mixDilution = bestDilutionChoice(dnf, sizes, deckSize, cardsSeenByT, othersCount, groupIds, activeMix);
  const mixOverall = mixDilution.rate;
  const mixNone = cantripSuccessRate(dnf, sizes, deckSize, cardsSeenByT, othersCount, mixDilution.group, []);
  // "with a cantrip drawn vs without" for the mix as a whole: treat the
  // combined mix as one pooled effect matching its own average bonus per
  // copy, weighted by count -- a reasonable summary stat for a mixed bag,
  // not a claim that every copy in the mix has this exact bonus.
  const totalMixCount = activeMix.reduce((s, m) => s + m.count, 0);
  const avgBonus = totalMixCount > 0 ? activeMix.reduce((s, m) => s + m.count * m.bonus, 0) / totalMixCount : 0;
  const conditional = totalMixCount > 0
    ? successGivenDrawnVsNot(dnf, sizes, deckSize, cardsSeenByT, othersCount, mixDilution.group, totalMixCount, avgBonus)
    : null;
  const mixDilutionName = groups.find((g) => g.id === mixDilution.group)?.name ?? mixDilution.group;

  return (
    <div>
      <table className="num-table">
        <thead>
          <tr>
            <th>effect</th>
            <th title="Averaged over a realistic 1&#8211;4 copies -- the exact value per copy declines as you add more. See &ldquo;build and test an exact mix&rdquo; below for the real curve.">
              &asymp; value/copy
            </th>
            <th>copies for {Math.round(target * 100)}% success</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {marginalRows.map((row) => (
            <tr key={row.i}>
              <td>
                <input
                  className="group-name"
                  style={{ width: 110 }}
                  value={row.name}
                  onChange={(e) => setEffects(effects.map((eff, i) => (i === row.i ? { ...eff, name: e.target.value } : eff)))}
                />
                <span className="hint" style={{ marginLeft: 4 }}>sees</span>
                <input
                  type="number" min={0} style={{ width: 34, marginLeft: 4 }}
                  value={row.bonus}
                  onChange={(e) => setEffects(effects.map((eff, i) => (i === row.i ? { ...eff, bonus: parseNumOr0(e.target.value) } : eff)))}
                />
              </td>
              <td>{row.marginal >= 0 ? `+${pct(row.marginal)}` : pct(row.marginal)}</td>
              <td>{row.needed === null ? 'not reachable' : row.needed}</td>
              <td>
                <button className="icon-btn" aria-label={`Remove ${row.name}`} onClick={() => setEffects(effects.filter((_, i) => i !== row.i))}>
                  &#10005;
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="add-look-btn" style={{ marginTop: 6 }} onClick={() => setEffects([...effects, { name: 'New effect', bonus: 1 }])}>
        + add effect type
      </button>

      <p className="hint" style={{ margin: '10px 0 0' }}>
        A {lookSize}-card look at your current deck:{' '}
        {lookComposition.map((g) => `${pct(g.pct)} ${g.name}`).join(' / ')}
        {otherPct > 0 && ` / ${pct(otherPct)} other`}.
      </p>

      <details className="q-more" open={showBuilder} onToggle={(e) => setShowBuilder((e.target as HTMLDetailsElement).open)}>
        <summary>Build and test an exact mix</summary>
        <div className="q-inner">
          <div className="look-list">
            {mix.map((row, i) => (
              <div className="look-row" key={i}>
                <input
                  type="number" min={0} className="q-blank"
                  value={row.count}
                  onChange={(e) => setMix(mix.map((m, j) => (j === i ? { ...m, count: parseNumOr0(e.target.value) } : m)))}
                />
                <span>that see</span>
                <input
                  type="number" min={0} className="q-blank"
                  value={row.bonus}
                  onChange={(e) => setMix(mix.map((m, j) => (j === i ? { ...m, bonus: parseNumOr0(e.target.value) } : m)))}
                />
                <span>cards</span>
                <span style={{ flex: 1 }} />
                <button className="icon-btn" aria-label="Remove mix row" onClick={() => setMix(mix.filter((_, j) => j !== i))}>
                  &#10005;
                </button>
              </div>
            ))}
            <button className="add-look-btn" onClick={() => setMix([...mix, { count: 1, bonus: 3 }])}>
              + add cantrip type
            </button>
          </div>

          <div className="q-result" style={{ marginTop: 0 }}>
            <b>{pct(mixOverall)}</b> success rate by turn {adviseTurn}, vs <b>{pct(mixNone)}</b> running none.
            {conditional && (
              <span className="also">{pct(conditional.givenDrawn)} if drawn by turn {adviseTurn}.</span>
            )}
          </div>

          <p className="q-scope">
            Cantrips dilute {mixDilutionName} once your {othersCount} filler slots run out (whichever tracked
            group is actually best to dilute, computed automatically -- not always the most populous one).
            Cascading (one cantrip&apos;s own look revealing another cantrip) isn&apos;t modeled &mdash; real
            values are likely somewhat higher throughout.
          </p>
        </div>
      </details>
    </div>
  );
}
