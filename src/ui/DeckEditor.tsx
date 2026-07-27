import { useAppDispatch, useAppState } from '../state/AppState';
import { parseQuery } from '../math/parse';
import { printExpr } from '../math/print';
import { resolverFor, nameOfFactory } from '../state/useQueryModel';

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
            type="number"
            min={1}
            max={1024}
            value={deckSize}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (Number.isFinite(v)) dispatch({ type: 'setDeckSize', deckSize: v });
            }}
          />
        </label>
        <label className="inline-field">
          <span>Hand</span>
          <input
            type="number"
            min={0}
            max={60}
            value={turnCfg.openingHand}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (Number.isFinite(v) && v >= 0) dispatch({ type: 'setTurnCfg', turnCfg: { openingHand: v } });
            }}
          />
        </label>
        <label className="inline-field">
          <span>Mull.</span>
          <input
            type="number"
            min={0}
            max={60}
            value={turnCfg.mulligans}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (Number.isFinite(v) && v >= 0) dispatch({ type: 'setTurnCfg', turnCfg: { mulligans: v } });
            }}
          />
        </label>
      </div>

      <div className="group-list">
        {groups.map((g) => (
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
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (Number.isFinite(v) && v >= 0) dispatch({ type: 'setGroupCount', id: g.id, count: v });
              }}
            />
            {/* Flex spacer goes HERE, between the input and delete -- not
                between the name and the input. Putting it on the name (an
                earlier mistake caught in mockup review) stretches the name
                to fill the row and shoves the count input next to delete,
                visually disconnecting it from the name it edits. */}
            <span className="spacer" />
            <button
              className="icon-btn"
              aria-label={`Remove ${g.name}`}
              onClick={() => dispatch({ type: 'removeGroup', id: g.id })}
            >
              &#10005;
            </button>
          </div>
        ))}
        <div className={`group-row others ${others < 0 ? 'bad' : ''}`}>
          <span className="dot" style={{ background: 'var(--text-muted)' }} />
          <span className="others-label">Others</span>
          <span className="spacer" />
          <span className="others-count">{others}</span>
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
      <button className="link-btn" onClick={() => dispatch({ type: 'addGroup' })}>
        + add group
      </button>
    </div>
  );
}
