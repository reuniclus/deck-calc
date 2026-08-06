/**
 * "How many copies do I need?" -- the inverse of the usual question.
 *
 * Deliberately narrow: no effects, no keeps, no policy. Just hypergeometry over
 * three axes (copies, how many you need, how many cards you see), which makes every
 * number here EXACT rather than modelled -- unlike the cantrip and mulligan tools,
 * which depend on play assumptions.
 *
 * The one-fewer column is the point of the card, not decoration. "16 copies" alone
 * hides that 15 reaches 88.2%, and giving up a deck slot for 1.9pt is usually the
 * right call -- so the bare answer would mislead in exactly the case a deck-builder
 * opens this for.
 *
 * Cards seen is entered directly rather than derived from a turn count: this question
 * gets asked about openers, about "by turn 3", and about arbitrary windows like a
 * Brainstorm's three, so a raw number is more useful than a turn picker here.
 *
 * Local component state only, same treatment as the other Questions cards.
 */
import { useMemo, useState } from 'react';
import { useAppState } from '../state/AppState';
import { copiesNeeded } from '../math/copiesNeeded';
import { NumberInput } from './NumberInput';

function pct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

const SEEN_PRESETS = [5, 6, 7, 10, 12, 15];

export function CopiesNeededCard() {
  const { deckSize } = useAppState();
  const [needed, setNeeded] = useState(1);
  const [seen, setSeen] = useState(7);
  const [target, setTarget] = useState(90);
  // Memoised: this card re-renders whenever ANY app state changes, and each answer is a
  // binary search over copy counts with an `evaluate` per probe. Recomputing four of them
  // on every unrelated keystroke was enough to make typing stutter on a phone.
  const rows = useMemo(
    () => [1, 2, 3].map((k) => ({ k, answer: copiesNeeded({ deckSize, needed: k, seen, target: target / 100 }) })),
    [deckSize, seen, target],
  );
  const focus = useMemo(
    () => copiesNeeded({ deckSize, needed, seen, target: target / 100 }),
    [deckSize, needed, seen, target],
  );

  return (
    <div>
      <p className="hint">
        Exact hypergeometry &mdash; no play assumptions, unlike the cantrip and mulligan tools.
      </p>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10 }}>
        <label>
          need at least
          <NumberInput
            type="number" min={1} max={10} value={needed}
            onCommit={(n) => setNeeded(Math.max(1, Math.min(10, n)))}
            style={{ width: 56, marginLeft: 6 }}
          />
        </label>
        <label>
          in the top
          <NumberInput
            type="number" min={1} max={deckSize} value={seen}
            onCommit={(n) => setSeen(Math.max(1, Math.min(deckSize, n)))}
            style={{ width: 64, marginLeft: 6 }}
          />
          cards
        </label>
        <label>
          at
          <NumberInput
            type="number" min={1} max={99} value={target}
            onCommit={(n) => setTarget(Math.max(1, Math.min(99, n)))}
            style={{ width: 56, marginLeft: 6 }}
          />
          %
        </label>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {SEEN_PRESETS.map((s) => (
          <button
            key={s} type="button" onClick={() => setSeen(s)}
            className={s === seen ? 'chip chip-on' : 'chip'}
          >
            top {s}
          </button>
        ))}
      </div>

      <p style={{ margin: '0 0 10px' }}>
        {focus.copies === null ? (
          <>
            <strong>Not reachable</strong> &mdash; even the whole deck can&apos;t give {target}% of finding{' '}
            {needed} in the top {seen}
            {needed > seen ? <> (you can&apos;t find {needed} in only {seen} cards)</> : null}.
          </>
        ) : (
          <>
            <strong>{focus.copies} copies</strong> reaches {pct(focus.achieved)}.{' '}
            <span className="hint">
              {focus.copies - 1} copies gives {pct(focus.achievedOneFewer)} &mdash;{' '}
              the last copy is worth {((focus.achieved - focus.achievedOneFewer) * 100).toFixed(1)}pt.
            </span>
          </>
        )}
      </p>

      <table className="grid">
        <thead>
          <tr>
            <th>need</th>
            <th>copies for {target}%</th>
            <th>achieved</th>
            <th>one fewer</th>
            <th>last copy worth</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ k, answer }) => (
            <tr key={k}>
              <td>{k}+</td>
              <td>{answer.copies === null ? '—' : answer.copies}</td>
              <td>{answer.copies === null ? '—' : pct(answer.achieved)}</td>
              <td>{answer.copies === null ? '—' : pct(answer.achievedOneFewer)}</td>
              <td>
                {answer.copies === null
                  ? '—'
                  : `${((answer.achieved - answer.achievedOneFewer) * 100).toFixed(1)}pt`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint" style={{ marginTop: 8 }}>
        Deck size {deckSize}, from the deck editor. Cards seen counts everything you look at,
        so an opener plus draws, or a Brainstorm&apos;s three.
      </p>
    </div>
  );
}
