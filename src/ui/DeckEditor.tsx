import { useState } from 'react';
import { useAppDispatch, useAppState } from '../state/AppState';
import { parseQuery } from '../math/parse';
import { printExpr } from '../math/print';
import { pruneGroups, collectGroups } from '../math/expr';
import { resolverFor, nameOfFactory } from '../state/useQueryModel';
import { parseNumOr0 } from './numberInput';
import { evaluate } from '../math/evaluate';
import { minSlotsForTarget } from '../math/allocate';

/** P(>=1 of this group in `n` cards seen), given `count` copies in a
 * `deckSize`-card deck. A trivial single-atom query -- no query text or
 * parsing involved, just the same evaluate() machinery everything else in
 * this app already uses, applied directly rather than through a full query. */
function handOdds(deckSize: number, count: number, n: number): number {
  const safeCount = Math.max(0, Math.min(count, deckSize));
  const sizes = { g0: safeCount };
  const dnf = { clauses: [{ g0: { lo: 1, hi: deckSize } }], monotone: true };
  return evaluate(deckSize, sizes, dnf).curve[Math.min(Math.max(n, 0), deckSize)] ?? 0;
}

/** Solve for the fewest copies of ONE group needed to reach `target` in `n`
 * cards seen, capped at `available` (deckSize minus every OTHER group's
 * current count). Silently caps to the best achievable within that space
 * rather than exceeding it, matching minSlotsForTarget's own extraSlots:null
 * fallback (best/bestP stay populated even when the target isn't reachable
 * within the cap) -- never returns a count that wouldn't fit. */
function solveCountForTarget(deckSize: number, n: number, target: number, available: number): { count: number; achievedP: number } {
  const capped = Math.max(0, Math.min(available, deckSize));
  const result = minSlotsForTarget({ g0: { lo: 1, hi: capped } }, n, deckSize, target);
  return { count: result.best?.g0 ?? 0, achievedP: result.bestP };
}

/** Deterministic, well-separated hue per group id — same scheme used for phantom
 * curves later, so a group's color is consistent everywhere it appears. */
const hueCache = new Map<string, number>();
export function hueFor(id: string): number {
  if (!hueCache.has(id)) hueCache.set(id, Math.round((hueCache.size * 137.508) % 360));
  return hueCache.get(id)!;
}
export function colorFor(id: string): string {
  return `hsl(${hueFor(id)}deg 65% 58%)`;
}

export function DeckEditor() {
  const { deckSize, groups, turnCfg, query } = useAppState();
  const dispatch = useAppDispatch();
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * A group's id never changes, but the query is stored as TEXT (name-based),
   * so renaming a group leaves the text pointing at a name that no longer
   * exists unless we reprint it. Parse under the OLD names (still current at
   * this point in the handler), then print the same AST under the NEW names.
   * If the query doesn't currently parse (already broken for some other
   * reason), there's nothing valid to reprint — just apply the rename.
   */
  function renameGroup(id: string, name: string): void {
    try {
      const ast = parseQuery(query, resolverFor(groups));
      const newGroups = groups.map((g) => (g.id === id ? { ...g, name } : g));
      dispatch({ type: 'renameGroup', id, name });
      dispatch({ type: 'setQuery', query: printExpr(ast, nameOfFactory(newGroups)) });
    } catch {
      dispatch({ type: 'renameGroup', id, name });
    }
  }

  /**
   * Deleting a group the query references used to leave the query pointing
   * at a name that no longer exists, throwing "unknown group" and forcing
   * the combos card into its all-or-nothing text fallback — NOT because the
   * query became structurally too complex, but because nothing cleaned up
   * after the delete. Fixed by auto-pruning the deleted group's own
   * conditions out of the query as part of the same action.
   *
   * This deliberately reverses an earlier design decision (PLAN.md/harness):
   * pruning used to require an explicit one-click confirmation, specifically
   * because silently changing what a query MEANS is the exact failure mode
   * that looks like a math bug. Requested explicitly here ("should handle
   * automatically") — kept the spirit of that caution by making it visible
   * (a one-line notice naming what was removed) rather than fully silent,
   * without forcing a manual click every time.
   */
  function removeGroup(id: string, name: string): void {
    try {
      const ast = parseQuery(query, resolverFor(groups));
      if (collectGroups(ast).has(id)) {
        const pruned = pruneGroups(ast, new Set([id]));
        const remainingGroups = groups.filter((g) => g.id !== id);
        dispatch({ type: 'removeGroup', id });
        dispatch({ type: 'setQuery', query: printExpr(pruned, nameOfFactory(remainingGroups)) });
        setNotice(`Removed "${name}" from the query.`);
        return;
      }
    } catch {
      // query already broken for some other reason -- nothing valid to prune
    }
    dispatch({ type: 'removeGroup', id });
    setNotice(null);
  }

  const others = deckSize - groups.reduce((s, g) => s + g.count, 0);
  const dupeName = groups.find((g, i) =>
    groups.findIndex((h) => h.name.trim().toLowerCase() === g.name.trim().toLowerCase()) !== i,
  )?.name;

  return (
    <div className="panel">
      <div className="row-line">
        <label className="inline-field">
          <span>Deck</span>
          <input
            className="deck-num deck-size-combo"
            type="text"
            inputMode="numeric"
            list="deck-size-presets"
            value={deckSize}
            onChange={(e) => dispatch({ type: 'setDeckSize', deckSize: parseNumOr0(e.target.value) })}
          />
          {/* type=text + inputMode=numeric, not type=number -- type=number
              has real, confirmed cross-browser inconsistency showing
              datalist suggestions (Safari in particular often only shows
              the current value, not the full option list). This keeps the
              numeric keyboard on mobile while making the combobox actually
              reliable. */}
          {/* Native combobox: type any size directly, or open the list for
              the common ones. Deliberately not 4 separate boxes (a plain
              value + 3 preset buttons) -- that layout could show the SAME
              number twice at once (e.g. "40" typed AND "40" highlighted as
              a separate, seemingly independent element) and cost real width
              on mobile for very little. One field can't have that problem:
              there's only ever one number on screen. */}
          <datalist id="deck-size-presets">
            <option value="40" />
            <option value="60" />
            <option value="99" />
          </datalist>
        </label>
        <label className="inline-field">
          <span>Hand</span>
          <input
            className="deck-num"
            type="number"
            min={0}
            max={60}
            value={turnCfg.openingHand}
            onChange={(e) =>
              dispatch({ type: 'setTurnCfg', turnCfg: { openingHand: parseNumOr0(e.target.value) } })}
          />
        </label>
        <label className="inline-field">
          <span>Mull.</span>
          <input
            className="deck-num"
            type="number"
            min={0}
            max={60}
            value={turnCfg.mulligans}
            onChange={(e) =>
              dispatch({ type: 'setTurnCfg', turnCfg: { mulligans: parseNumOr0(e.target.value) } })}
          />
        </label>
      </div>

      <div className="group-list">
        {groups.map((g) => {
          const otherTotal = groups.filter((x) => x.id !== g.id).reduce((s, x) => s + x.count, 0);
          const available = deckSize - otherTotal;
          const pct = Math.round(handOdds(deckSize, g.count, turnCfg.openingHand) * 100);
          return (
            <div className="group-row" key={g.id}>
              <span className="dot" style={{ background: colorFor(g.id) }} />
              <input
                className="group-name"
                value={g.name}
                onChange={(e) => renameGroup(g.id, e.target.value)}
              />
              <input
                className="group-count"
                type="number"
                min={0}
                value={g.count}
                onChange={(e) =>
                  dispatch({ type: 'setGroupCount', id: g.id, count: parseNumOr0(e.target.value) })}
              />
              <span className="goal-pct-sign">&rarr;</span>
              <input
                className="goal-input"
                type="number"
                min={0}
                max={100}
                value={pct}
                onChange={(e) => {
                  const target = Math.max(0, Math.min(100, parseNumOr0(e.target.value))) / 100;
                  const { count } = solveCountForTarget(deckSize, turnCfg.openingHand, target, available);
                  dispatch({ type: 'setGroupCount', id: g.id, count });
                }}
              />
              <span className="goal-pct-sign">%</span>
              <span className="goal-context">in opening hand</span>
              {/* Flex spacer goes HERE, between the input and delete -- not
                  between the name and the input. Putting it on the name (an
                  earlier mistake caught in mockup review) stretches the name
                  to fill the row and shoves the count input next to delete,
                  visually disconnecting it from the name it edits. */}
              <span className="spacer" />
              <button
                className="icon-btn"
                aria-label={`Remove ${g.name}`}
                onClick={() => removeGroup(g.id, g.name)}
              >
                &#10005;
              </button>
            </div>
          );
        })}
        <div className={`group-row others ${others < 0 ? 'bad' : ''}`}>
          <span className="dot" style={{ background: 'var(--text-muted)' }} />
          <span className="others-label">Others</span>
          <span className="others-count">{others}</span>
          <span className="spacer" />
          <span className="others-placeholder" aria-hidden="true" />
        </div>
      </div>
      {others < 0 && (
        <p className="hint bad">
          Groups total {deckSize - others} cards but the deck is {deckSize}. Reduce a group or raise the deck size.
        </p>
      )}
      {dupeName && (
        <p className="hint bad">
          Duplicate group name: &quot;{dupeName}&quot;. Names must be unique — groups are disjoint.
        </p>
      )}
      {notice && <p className="hint">{notice}</p>}
      <button className="link-btn" onClick={() => dispatch({ type: 'addGroup' })}>
        + add group
      </button>
    </div>
  );
}
