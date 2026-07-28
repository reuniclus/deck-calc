import { useState } from 'react';
import { useAppState, useAppDispatch, type Group } from '../state/AppState';
import { useQueryModelCtx, nameOfFactory } from '../state/useQueryModel';
import { compileFlat, type Row, type FlatQuery } from '../math/builder';
import { printExpr } from '../math/print';
import { colorFor } from './DeckEditor';
import { parseNumOr0 } from './numberInput';

type Cmp = 'gte' | 'lte' | 'eq' | 'range';

function cmpOf(r: Row): Cmp {
  if (r.hi === null) return 'gte';
  if (r.lo === 0) return 'lte';
  if (r.lo === r.hi) return 'eq';
  return 'range';
}

interface RowParts { name: string; rest: string }

function rowParts(row: Row, nameOf: (id: string) => string): RowParts {
  const name = nameOf(row.g);
  const cmp = cmpOf(row);
  const rest =
    cmp === 'gte' ? `\u2265 ${row.lo}`
    : cmp === 'lte' ? `\u2264 ${row.hi}`
    : cmp === 'eq' ? `= ${row.lo}`
    : `${row.lo}\u2013${row.hi}`;
  return { name, rest };
}

function QueryTextArea() {
  const { query } = useAppState();
  const dispatch = useAppDispatch();
  return (
    <textarea
      className="query-textarea"
      value={query}
      spellCheck={false}
      onChange={(e) => dispatch({ type: 'setQuery', query: e.target.value })}
    />
  );
}

function ComboRow({
  row, groups, onChange, onDelete,
}: {
  row: Row;
  groups: Group[];
  onChange: (r: Row) => void;
  onDelete: () => void;
}) {
  const cmp = cmpOf(row);
  return (
    <div className="combo-row">
      <span className="dot" style={{ background: colorFor(row.g) }} />
      <select className="group-select" value={row.g} onChange={(e) => onChange({ ...row, g: e.target.value })}>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>{g.name}</option>
        ))}
      </select>
      <select
        className="cmp-select"
        value={cmp}
        onChange={(e) => {
          const v = e.target.value as Cmp;
          const K = groups.find((g) => g.id === row.g)?.count ?? 1;
          if (v === 'gte') onChange({ ...row, lo: Math.max(1, row.lo || 1), hi: null });
          else if (v === 'lte') onChange({ ...row, hi: row.hi ?? K, lo: 0 });
          else if (v === 'eq') { const n = row.lo || 1; onChange({ ...row, lo: n, hi: n }); }
          else { const hi = row.hi ?? K; onChange({ ...row, hi, lo: Math.min(row.lo || 0, hi) }); }
        }}
      >
        <option value="gte">&ge;</option>
        <option value="lte">&le;</option>
        <option value="eq">=</option>
        <option value="range">range</option>
      </select>
      <input
        type="number"
        min={0}
        className="num-sm"
        value={cmp === 'lte' ? row.hi ?? 0 : row.lo}
        onChange={(e) => {
          const v = parseNumOr0(e.target.value);
          if (cmp === 'lte') onChange({ ...row, hi: v });
          else if (cmp === 'eq') onChange({ ...row, lo: v, hi: v });
          else onChange({ ...row, lo: v });
        }}
      />
      {cmp === 'range' && (
        <>
          <span className="hint">to</span>
          <input
            type="number"
            min={0}
            className="num-sm"
            value={row.hi ?? 0}
            onChange={(e) => onChange({ ...row, hi: parseNumOr0(e.target.value) })}
          />
        </>
      )}
      <span className="spacer" />
      <button className="icon-btn" aria-label="Remove condition" onClick={onDelete}>&#10005;</button>
    </div>
  );
}

export function CombosEditor() {
  const { groups } = useAppState();
  const dispatch = useAppDispatch();
  const { flat, error } = useQueryModelCtx();
  const nameOf = nameOfFactory(groups);
  const [expanded, setExpanded] = useState<Set<number>>(new Set([0]));
  const [manualText, setManualText] = useState(false);

  function applyFlat(next: FlatQuery): void {
    dispatch({ type: 'setQuery', query: printExpr(compileFlat(next), nameOf) });
  }

  function toggle(ci: number): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(ci)) next.delete(ci); else next.add(ci);
      return next;
    });
  }

  // All-or-nothing fallback: real nesting the flat model can't represent, or a
  // parse error. Either way there is no structured view to offer -- text is
  // the only editing surface, and the "edit as text" toggle below doesn't
  // apply because there's nothing to switch back to.
  if (!flat) {
    return (
      <div className="panel">
        <div className="section-label">Combos</div>
        {error ? (
          <p className="hint bad">{error}</p>
        ) : (
          <p className="hint flag">This combo structure is too nested for the builder. Edit it as text.</p>
        )}
        <QueryTextArea />
      </div>
    );
  }

  if (manualText) {
    return (
      <div className="panel">
        <div className="section-label">Combos</div>
        <QueryTextArea />
        <button className="link-btn" onClick={() => setManualText(false)}>Back to builder</button>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="section-label">Combos</div>
      {flat.clauses.map((clause, ci) => {
        const isOpen = expanded.has(ci);
        return (
          <div className="combo-box" key={ci}>
            <button className="combo-toggle" onClick={() => toggle(ci)}>
              <span className="chevron">{isOpen ? '\u25be' : '\u25b8'}</span>
              {isOpen ? <span className="hint">editing</span> : (
                <span className="combo-summary">
                  {clause.rows.map((r, ri) => {
                    const { name, rest } = rowParts(r, nameOf);
                    return (
                      <span className="combo-summary-item" key={ri}>
                        {ri > 0 && <span className="hint">and</span>}
                        <span className="dot inline" style={{ background: colorFor(r.g) }} />
                        <span className="truncate-name">{name}</span>
                        <span className="hint">{rest}</span>
                      </span>
                    );
                  })}
                </span>
              )}
            </button>
            {isOpen && (
              <div className="combo-rows">
                {clause.rows.map((row, ri) => (
                  <ComboRow
                    key={ri}
                    row={row}
                    groups={groups}
                    onChange={(newRow) => applyFlat({
                      clauses: flat.clauses.map((c, i) =>
                        i === ci ? { rows: c.rows.map((r, j) => (j === ri ? newRow : r)) } : c),
                    })}
                    onDelete={() => {
                      const newRows = clause.rows.filter((_, j) => j !== ri);
                      applyFlat(newRows.length === 0
                        ? { clauses: flat.clauses.filter((_, i) => i !== ci) }
                        : { clauses: flat.clauses.map((c, i) => (i === ci ? { rows: newRows } : c)) });
                    }}
                  />
                ))}
                <button
                  className="link-btn"
                  onClick={() => applyFlat({
                    clauses: flat.clauses.map((c, i) =>
                      i === ci ? { rows: [...c.rows, { g: groups[0]?.id ?? '', lo: 1, hi: null }] } : c),
                  })}
                >
                  + add condition
                </button>
              </div>
            )}
          </div>
        );
      })}
      <div className="row-line">
        <button
          className="link-btn"
          onClick={() => {
            const newIndex = flat.clauses.length;
            applyFlat({
              clauses: [...flat.clauses, { rows: [{ g: groups[0]?.id ?? '', lo: 1, hi: null }] }],
            });
            setExpanded((prev) => new Set(prev).add(newIndex));
          }}
        >
          + add combo
        </button>
        <button className="link-btn" onClick={() => setManualText(true)}>Edit as text</button>
      </div>
    </div>
  );
}
