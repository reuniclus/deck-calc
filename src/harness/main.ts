/**
 * Barebones dev harness. Plain DOM on purpose — this is the window onto the math
 * layer while the real React UI is still unwritten. Imports the same modules the
 * app will, so it cannot drift from the tested code.
 */
import { parseQuery, ParseError } from '../math/parse';
import { printExpr } from '../math/print';
import { normalize } from '../math/normalize';
import { evaluate } from '../math/evaluate';
import { analyze } from '../math/analyze';
import { turnForCardsSeen, DEFAULT_TURN_CONFIG, type TurnConfig } from '../model/turns';
import { minimalVectors } from '../math/frontier';
import { allocate, minSlotsForTarget } from '../math/allocate';
import { compileFlat, decompileFlat, type Row, type Mode, type FlatQuery } from '../math/builder';
import {
  QueryTooLargeError, UnknownGroupError, collectGroups, pruneGroups, type Expr, type Sizes,
} from '../math/expr';

interface Group { id: string; name: string; count: number }

const state = {
  deckSize: 40,
  groups: [
    { id: 'g0', name: 'A', count: 4 },
    { id: 'g1', name: 'B', count: 3 },
  ] as Group[],
  /** Display text. Regenerated from `ast` whenever a group is renamed. */
  query: 'A>=1 & B>=1',
  /**
   * Source of truth for the query, holding group IDS. Names are presentation only,
   * so renaming a group can never invalidate a query. PLAN.md §8.
   */
  ast: null as Expr | null,
  queryError: null as string | null,
  /** Last-known display name for a group after it's been deleted, so error messages can name it. */
  ghostNames: {} as Record<string, string>,
  /**
   * The builder mirrors state.ast when possible (decompileFlat succeeds) and is
   * the AUTHORING side: editing a row calls applyBuilder(), which compiles ->
   * prints -> setQueryText, so text stays the single source of truth throughout.
   */
  builder: null as FlatQuery | null,
  builderUnavailable: false,
  target: 0.9,
  turnCfg: { ...DEFAULT_TURN_CONFIG } as TurnConfig,
  gridGroup: 'g0',
  gridMaxDraws: 20,
  /** value = raw P; dCopy = marginal gain from the next copy; dDraw = marginal gain from the next card drawn. */
  gridMode: 'value' as 'value' | 'dCopy' | 'dDraw',
  resultView: 'chart' as 'chart' | 'table',
};
let seq = 2;

const $ = (id: string) => document.getElementById(id)!;
const pct = (p: number) => (p * 100).toFixed(2) + '%';
const signed = (p: number) => (p >= 0 ? '+' : '−') + (Math.abs(p) * 100).toFixed(2) + '%';

const others = () => state.deckSize - state.groups.reduce((a, g) => a + g.count, 0);

function sizesOf(groups: Group[]): Sizes {
  const s: Record<string, number> = {};
  for (const g of groups) s[g.id] = g.count;
  return s;
}

function resolverFor(groups: Group[]) {
  return (name: string): string | null =>
    groups.find((g) => g.name.toLowerCase() === name.trim().toLowerCase())?.id ?? null;
}

const nameOf = (id: string): string => state.groups.find((g) => g.id === id)?.name ?? '?';

/** Ids in the query that no longer correspond to a group. */
function danglingIds(): string[] {
  if (!state.ast) return [];
  const live = new Set(state.groups.map((g) => g.id));
  return [...collectGroups(state.ast)].filter((id) => !live.has(id));
}

/** Text -> AST. Keeps the previous AST on failure so a later rename can still re-print. */
function setQueryText(text: string): void {
  state.query = text;
  try {
    state.ast = parseQuery(text, resolverFor(state.groups));
    state.queryError = null;
    syncBuilderFromAst();
  } catch (e) {
    state.queryError = describeError(e);
    // keep whatever builder state we had; the text is what's broken, not the model
  }
}

/** Mirror state.ast into the builder when it's flat enough; otherwise flag it. */
function syncBuilderFromAst(): void {
  if (!state.ast) { state.builder = null; state.builderUnavailable = false; return; }
  const fq = decompileFlat(state.ast);
  if (fq) { state.builder = fq; state.builderUnavailable = false; }
  else { state.builderUnavailable = true; } // leave last-known rows alone
}

/** Builder -> Expr -> text. The builder never edits state.ast directly. */
function applyBuilder(): void {
  if (!state.builder) return;
  const expr = compileFlat(state.builder);
  const text = printExpr(expr, nameOf);
  setQueryText(text);
  ($('query') as HTMLTextAreaElement).value = state.query;
  recompute();
}

/** AST -> text, using each group's CURRENT name. */
function reprintQuery(): void {
  if (!state.ast || state.queryError || danglingIds().length > 0) return;
  state.query = printExpr(state.ast, nameOf);
  ($('query') as HTMLTextAreaElement).value = state.query;
}

// ── query builder ────────────────────────────────────────────────────────────
function cmpOf(row: Row): 'gte' | 'lte' | 'eq' | 'range' {
  if (row.hi === null) return 'gte';
  if (row.lo === 0) return 'lte';
  if (row.lo === row.hi) return 'eq';
  return 'range';
}

function groupOptsHtml(selected: string): string {
  return state.groups
    .map((g) => `<option value="${g.id}" ${g.id === selected ? 'selected' : ''}>${escapeHtml(g.name)}</option>`)
    .join('');
}

/** One condition's controls. `attrs` locates it later — either `data-i` (flat) or `data-ci`+`data-ri` (inside a combo). */
function rowControlsHtml(r: Row, attrs: string): string {
  const cmp = cmpOf(r);
  return `<span class="brow" ${attrs}>
    <button class="bneg ${r.neg ? 'on' : ''}" ${attrs} title="negate">${r.neg ? 'NOT' : 'not'}</button>
    <select class="bgroup" ${attrs}>${groupOptsHtml(r.g)}</select>
    <select class="bcmp" ${attrs}>
      <option value="gte" ${cmp === 'gte' ? 'selected' : ''}>&ge;</option>
      <option value="lte" ${cmp === 'lte' ? 'selected' : ''}>&le;</option>
      <option value="eq" ${cmp === 'eq' ? 'selected' : ''}>=</option>
      <option value="range" ${cmp === 'range' ? 'selected' : ''}>range</option>
    </select>
    <input class="bnum1" ${attrs} type="number" min="0" value="${cmp === 'lte' ? r.hi : r.lo}" style="width:3.5rem">
    ${cmp === 'range' ? `<span class="hint">to</span><input class="bnum2" ${attrs} type="number" min="0" value="${r.hi}" style="width:3.5rem">` : ''}
    <button class="bdel" ${attrs}>✕</button>
  </span>`;
}

/** Reads a row's location (flat index, or clause+row index) off an element's dataset. */
function locateRow(el: HTMLElement): Row | undefined {
  const b = state.builder;
  if (!b) return undefined;
  if (el.dataset.ci !== undefined) {
    return b.clauses[Number(el.dataset.ci)]?.rows[Number(el.dataset.ri)];
  }
  return b.rows[Number(el.dataset.i)];
}

/** Shared wiring for value-only edits (negate/group/comparator/numbers) — works for both flat rows and clause rows. */
function wireRowControls(box: HTMLElement): void {
  box.querySelectorAll<HTMLButtonElement>('.bneg').forEach((el) => {
    el.onclick = () => {
      const r = locateRow(el); if (!r) return;
      r.neg = !r.neg;
      renderBuilder(); applyBuilder();
    };
  });
  box.querySelectorAll<HTMLSelectElement>('.bgroup').forEach((el) => {
    el.onchange = () => {
      const r = locateRow(el); if (!r) return;
      r.g = el.value;
      applyBuilder();
    };
  });
  box.querySelectorAll<HTMLSelectElement>('.bcmp').forEach((el) => {
    el.onchange = () => {
      const r = locateRow(el); if (!r) return;
      const v = el.value as 'gte' | 'lte' | 'eq' | 'range';
      const g = state.groups.find((x) => x.id === r.g);
      const K = g?.count ?? 1;
      if (v === 'gte') { r.lo = Math.max(1, r.lo || 1); r.hi = null; }
      else if (v === 'lte') { r.hi = r.hi ?? K; r.lo = 0; }
      else if (v === 'eq') { const n = r.lo || 1; r.lo = n; r.hi = n; }
      else { r.hi = r.hi ?? K; r.lo = Math.min(r.lo || 0, r.hi); }
      renderBuilder(); applyBuilder();
    };
  });
  box.querySelectorAll<HTMLInputElement>('.bnum1').forEach((el) => {
    el.oninput = () => {
      const r = locateRow(el); if (!r) return;
      const v = parseInt(el.value, 10);
      if (!Number.isFinite(v) || v < 0) return;
      const cmp = cmpOf(r);
      if (cmp === 'lte') r.hi = v;
      else if (cmp === 'eq') { r.lo = v; r.hi = v; }
      else r.lo = v; // gte or range's lo
      applyBuilder();
    };
  });
  box.querySelectorAll<HTMLInputElement>('.bnum2').forEach((el) => {
    el.oninput = () => {
      const r = locateRow(el); if (!r) return;
      const v = parseInt(el.value, 10);
      if (Number.isFinite(v) && v >= 0) { r.hi = v; applyBuilder(); }
    };
  });
}

function renderBuilder(): void {
  const box = $('builder');
  if (state.groups.length === 0) {
    box.innerHTML = '<p class="hint">Add a group first.</p>';
    return;
  }
  if (state.builderUnavailable) {
    box.innerHTML = `<p class="hint flag">Current query has real nesting this picker can't represent
       yet (e.g. an AND inside an OR that isn't shaped as "combos", or a NOT of more than a single
       condition) — too complex for this picker. Text still works below.
       Your last builder state is kept in case you switch back.</p>`;
    return;
  }
  if (!state.builder) {
    box.innerHTML = `<p class="hint">No query yet.</p>`;
    return;
  }

  const b = state.builder;
  const modeSelectHtml = `
    <select id="bmode">
      <option value="and" ${b.mode === 'and' ? 'selected' : ''}>all of these (AND)</option>
      <option value="or" ${b.mode === 'or' ? 'selected' : ''}>any of these combos (OR)</option>
      <option value="atLeastK" ${b.mode === 'atLeastK' ? 'selected' : ''}>at least N of these</option>
    </select>
    ${b.mode === 'atLeastK'
      ? `<input id="bk" type="number" min="1" max="${Math.max(1, b.rows.length)}" value="${b.k}" style="width:3.5rem">`
      : ''}`;

  if (b.mode === 'or') {
    const clausesHtml = b.clauses.map((c, ci) => {
      const rowsHtml = c.rows
        .map((r, ri) => rowControlsHtml(r, `data-ci="${ci}" data-ri="${ri}"`))
        .join('<span class="hint conj">and</span>');
      return `<div class="bclause">
        <div class="bclause-rows">${rowsHtml || '<span class="hint">empty — add a condition</span>'}</div>
        <div class="bclause-actions">
          <button class="baddCond" data-ci="${ci}">+ and condition</button>
          <button class="bdelClause" data-ci="${ci}">✕ remove this combo</button>
        </div>
      </div>`;
    }).join('<div class="hint conj-or">— or —</div>');

    box.innerHTML = `
      <div class="row" style="margin-bottom:.5rem">${modeSelectHtml}<button id="baddClause">+ combo</button></div>
      ${clausesHtml || '<p class="hint">No combos yet — add one.</p>'}`;

    wireModeControls();
    wireRowControls(box);
    box.querySelectorAll<HTMLButtonElement>('.baddCond').forEach((el) => {
      el.onclick = () => {
        const ci = Number(el.dataset.ci);
        state.builder!.clauses[ci]!.rows.push({ g: state.groups[0]!.id, neg: false, lo: 1, hi: null });
        renderBuilder(); applyBuilder();
      };
    });
    box.querySelectorAll<HTMLButtonElement>('.bdelClause').forEach((el) => {
      el.onclick = () => {
        const ci = Number(el.dataset.ci);
        state.builder!.clauses.splice(ci, 1);
        renderBuilder(); applyBuilder();
      };
    });
    box.querySelectorAll<HTMLButtonElement>('.bdel').forEach((el) => {
      el.onclick = () => {
        const ci = Number(el.dataset.ci), ri = Number(el.dataset.ri);
        const clause = state.builder!.clauses[ci];
        if (!clause) return;
        clause.rows.splice(ri, 1);
        if (clause.rows.length === 0) state.builder!.clauses.splice(ci, 1); // drop the now-empty combo
        renderBuilder(); applyBuilder();
      };
    });
    return;
  }

  // 'and' / 'atLeastK': one flat list of rows, unchanged shape from before.
  const rowsHtml = b.rows.map((r, i) => rowControlsHtml(r, `data-i="${i}"`)).join('');
  box.innerHTML = `
    <div class="row" style="margin-bottom:.5rem">${modeSelectHtml}<button id="baddRow">+ condition</button></div>
    ${rowsHtml || '<p class="hint">No conditions yet — add one.</p>'}`;

  wireModeControls();
  wireRowControls(box);
  $('baddRow').addEventListener('click', () => {
    state.builder!.rows.push({ g: state.groups[0]!.id, neg: false, lo: 1, hi: null });
    renderBuilder(); applyBuilder();
  });
  box.querySelectorAll<HTMLButtonElement>('.bdel').forEach((el) => {
    el.onclick = () => {
      const i = Number(el.dataset.i);
      state.builder!.rows.splice(i, 1);
      if (state.builder!.mode === 'atLeastK') {
        state.builder!.k = Math.min(state.builder!.k, Math.max(1, state.builder!.rows.length));
      }
      renderBuilder(); applyBuilder();
    };
  });

  function wireModeControls(): void {
    ($('bmode') as HTMLSelectElement).onchange = (e) => {
      switchBuilderMode((e.target as HTMLSelectElement).value as Mode);
    };
    const bk = document.getElementById('bk') as HTMLInputElement | null;
    if (bk) bk.oninput = () => {
      const v = parseInt(bk.value, 10);
      if (Number.isFinite(v) && v >= 1) { state.builder!.k = v; applyBuilder(); }
    };
  }
}

/** Converts the CURRENT rows/clauses into the new mode's shape rather than discarding them. */
function switchBuilderMode(mode: Mode): void {
  const b = state.builder!;
  if (mode === 'or' && b.mode !== 'or') {
    // each existing flat row becomes its own single-condition combo
    b.clauses = b.rows.map((r) => ({ rows: [r] }));
    b.rows = [];
  } else if (mode !== 'or' && b.mode === 'or') {
    // flatten every combo's rows back into one list (lossy if there were 2+ combos with 2+ rows each,
    // but that's an inherent shape change, not a bug — AND/atLeastK have no notion of separate combos)
    b.rows = b.clauses.flatMap((c) => c.rows);
    b.clauses = [];
  }
  b.mode = mode;
  if (mode === 'atLeastK') b.k = Math.min(b.k || 1, Math.max(1, b.rows.length));
  renderBuilder(); applyBuilder();
}


// ── deck editor ──────────────────────────────────────────────────────────────
function renderDeck(): void {
  const rows = state.groups.map((g) => `
    <tr>
      <td><input class="name" data-id="${g.id}" value="${escapeAttr(g.name)}" size="12"></td>
      <td><input class="count" data-id="${g.id}" type="number" min="0" value="${g.count}" size="4"></td>
      <td><button class="del" data-id="${g.id}">✕</button></td>
    </tr>`).join('');

  const o = others();
  $('groups').innerHTML = `
    <table class="deck">
      <thead><tr><th>group</th><th>copies</th><th></th></tr></thead>
      <tbody>${rows}
        <tr class="others ${o < 0 ? 'bad' : ''}">
          <td>others <span class="hint">(derived)</span></td>
          <td><input value="${o}" disabled></td><td></td>
        </tr>
      </tbody>
    </table>`;

  $('groups').querySelectorAll<HTMLInputElement>('input.name').forEach((el) => {
    el.oninput = () => {
      setGroup(el.dataset.id!, { name: el.value });
      reprintQuery(); // the query tracks the group, not the old spelling
      renderGridPicker();
      recompute();
    };
  });
  // Commit on change, not on every keystroke: never clamp or reflow mid-typing.
  $('groups').querySelectorAll<HTMLInputElement>('input.count').forEach((el) => {
    el.oninput = () => {
      const v = parseInt(el.value, 10);
      if (Number.isFinite(v) && v >= 0) {
        setGroup(el.dataset.id!, { count: v });
        renderOthers();
        recompute();
      }
    };
  });
  $('groups').querySelectorAll<HTMLButtonElement>('button.del').forEach((el) => {
    el.onclick = () => {
      const dead = state.groups.find((g) => g.id === el.dataset.id);
      if (dead) state.ghostNames[dead.id] = dead.name;
      state.groups = state.groups.filter((g) => g.id !== el.dataset.id);
      if (state.gridGroup === el.dataset.id) state.gridGroup = state.groups[0]?.id ?? '';
      renderDeck(); renderGridPicker(); recompute();
    };
  });
}

/**
 * Update only the derived `others` cell. A full renderDeck() here would destroy
 * focus and cursor position while the user is still typing a count.
 */
function renderOthers(): void {
  const row = $('groups').querySelector('tr.others');
  if (!row) return;
  const o = others();
  row.classList.toggle('bad', o < 0);
  const input = row.querySelector('input');
  if (input instanceof HTMLInputElement) input.value = String(o);
}

function setGroup(id: string, patch: Partial<Group>): void {
  state.groups = state.groups.map((g) => (g.id === id ? { ...g, ...patch } : g));
}

function renderGridPicker(): void {
  const sel = $('gridGroup') as HTMLSelectElement;
  sel.innerHTML = state.groups
    .map((g) => `<option value="${g.id}" ${g.id === state.gridGroup ? 'selected' : ''}>${escapeHtml(g.name)}</option>`)
    .join('');
}

// ── main compute ─────────────────────────────────────────────────────────────
function recompute(): void {
  const N = state.deckSize;
  const o = others();
  const warn = $('warn');

  if (o < 0) {
    warn.textContent = `Groups total ${N - o} cards but the deck is ${N}. Reduce a group or raise the deck size.`;
    warn.className = 'warn bad';
    clearViews();
    renderBuilder();
    return;
  }
  const dupes = state.groups.filter((g, i) =>
    state.groups.findIndex((h) => h.name.trim().toLowerCase() === g.name.trim().toLowerCase()) !== i);
  if (dupes.length) {
    warn.textContent = `Duplicate group name: "${dupes[0]!.name}". Names must be unique — groups are disjoint.`;
    warn.className = 'warn bad';
    clearViews();
    renderBuilder();
    return;
  }
  warn.textContent = '';
  warn.className = 'warn';
  renderBuilder();

  const dangling = danglingIds();
  if (dangling.length > 0) {
    const names = dangling.map((id) => state.ghostNames[id] ?? id);
    clearViews();
    $('status').innerHTML =
      `<span class="bad">Query still references ${names.length === 1 ? 'a deleted group' : 'deleted groups'}: `
      + `${names.map(escapeHtml).join(', ')}.</span> `
      + `<button id="pruneDangling">Remove from query</button>`;
    const btn = document.getElementById('pruneDangling');
    if (btn) btn.onclick = () => {
      state.ast = pruneGroups(state.ast!, new Set(dangling));
      reprintQuery();
      recompute();
    };
    return;
  }
  if (state.queryError) return failQuery(state.queryError);
  if (!state.ast) return failQuery('No query.');

  const sizes = sizesOf(state.groups);
  let res: ReturnType<typeof evaluate>;
  let dnf: ReturnType<typeof normalize>;
  try {
    dnf = normalize(state.ast, sizes);
    res = evaluate(N, sizes, dnf);
  } catch (e) {
    return failQuery(describeError(e));
  }

  const a = analyze(res.curve, state.target, res.monotone);
  renderStatus(res, a);
  renderSummary(a);
  renderCurve(a, computeCurveSeries(state.ast!, res.curve));
  renderTable(a);
  renderGrid();
  renderFrontier(dnf, a, sizes);
}

/** Deterministic, well-separated hue per group, independent of how many groups exist. */
const GROUP_HUES = new Map<string, number>();
function hueFor(groupId: string): number {
  if (!GROUP_HUES.has(groupId)) {
    GROUP_HUES.set(groupId, Math.round((GROUP_HUES.size * 137.508) % 360)); // golden angle
  }
  return GROUP_HUES.get(groupId)!;
}

interface CurveSeries {
  curve: Float64Array;
  /** null for the real, current-deck curve. */
  offset: number | null;
  groupId: string | null;
  color: string;
  /** Full group-by-group card counts that produced this curve, for the tooltip. */
  composition: string;
}

/**
 * One phantom fan per group (+-1/+-2 copies, holding every other group fixed),
 * color-coded by group so several groups' sensitivity can be read at once —
 * plus the real curve as its own series so both share one draw/tooltip path.
 */
function computeCurveSeries(ast: Expr, realCurve: Float64Array): CurveSeries[] {
  const compositionOf = (groups: Group[]): string =>
    groups.map((x) => `${x.name}=${x.count}`).join(', ');

  const out: CurveSeries[] = [{
    curve: realCurve, offset: null, groupId: null,
    color: 'var(--acc)', composition: compositionOf(state.groups),
  }];

  for (const g of state.groups) {
    const color = `hsl(${hueFor(g.id)}deg 65% 58%)`;
    for (const offset of [-2, -1, 1, 2]) {
      const count = g.count + offset;
      if (count < 0) continue;
      const groups = state.groups.map((x) => (x.id === g.id ? { ...x, count } : x));
      try {
        const s = sizesOf(groups);
        out.push({
          curve: evaluate(state.deckSize, s, normalize(ast, s)).curve,
          offset, groupId: g.id, color, composition: compositionOf(groups),
        });
      } catch {
        // deck too small to hold this many copies, or some other constraint violation — skip it
      }
    }
  }
  return out;
}

function renderFrontier(
  dnf: ReturnType<typeof normalize>,
  a: ReturnType<typeof analyze>,
  sizes: Sizes,
): void {
  const box = $('frontier');
  if (!dnf.monotone) {
    box.innerHTML = `<p class="hint flag">Only available for monotone queries (every group used as
      &ge;, no NOT). This query has an upper bound somewhere, so "fewest slots" isn't well posed —
      P can fall as well as rise.</p>`;
    return;
  }
  if (dnf.clauses.length !== 1) {
    box.innerHTML = `<p class="hint">Only available for a single AND-clause (no OR) right now —
      allocation across the branches of an OR is a separate question.</p>`;
    return;
  }
  const clause = dnf.clauses[0]!;
  const groups = Object.keys(clause);
  if (groups.length === 0) {
    box.innerHTML = `<p class="hint">No group is constrained — nothing to allocate.</p>`;
    return;
  }
  if (groups.length > 4) {
    box.innerHTML = `<p class="hint">${groups.length} groups in one clause — allocation search is
      capped at 4 for now.</p>`;
    return;
  }

  const N = state.deckSize;
  const n = a.drawsNeeded ?? a.argmaxP;

  let vectors: ReturnType<typeof minimalVectors>['vectors'] = [];
  let bestP = 0;
  try {
    ({ vectors, bestP } = minimalVectors(clause, n, N, state.target));
  } catch (e) {
    box.innerHTML = `<p class="hint bad">${escapeHtml(e instanceof Error ? e.message : String(e))}</p>`;
    return;
  }

  const rowsHtml = vectors
    .sort((x, y) => groups.reduce((s, g) => s + x[g]! - y[g]!, 0))
    .map((v) => `<tr>${groups.map((g) => `<td>${v[g]}</td>`).join('')}</tr>`)
    .join('');

  const vecPart = vectors.length === 0
    ? `<p class="hint flag">Not reachable at ${n} cards drawn within the searched range
       (best ${pct(bestP)}). Try a lower target or more draws.</p>`
    : `<table class="num"><thead><tr>${groups.map((g) => `<th>${escapeHtml(nameOf(g))}</th>`).join('')}</tr></thead>
       <tbody>${rowsHtml}</tbody></table>
       <p class="hint">Each row is a minimal combination — none can be trimmed further without
       dropping below ${pct(state.target)}. All are genuine tradeoffs, not ranked.</p>`;

  const allocPart = renderAllocation(clause, groups, n, N, sizes);

  box.innerHTML = `<p class="hint">at n=${n} cards drawn${turnSuffix(n)}, target ${pct(state.target)}</p>
    ${vecPart}<div style="margin-top:1rem">${allocPart}</div>`;
}

function renderAllocation(
  clause: ReturnType<typeof normalize>['clauses'][number],
  groups: string[],
  n: number,
  N: number,
  sizes: Sizes,
): string {
  const currentSpend = groups.reduce((s, g) => s + (sizes[g] ?? 0), 0);
  if (groups.length < 2) return '';

  const alloc = allocate(clause, n, N, currentSpend);
  const dual = minSlotsForTarget(clause, n, N, state.target);
  const baseline = groups.reduce((s, g) => s + clause[g]!.lo, 0);

  const bestRow = groups.map((g) => `${escapeHtml(nameOf(g))}: ${alloc.best[g]}`).join(', ');
  const dualRow = dual.extraSlots === null
    ? `never reaches ${pct(state.target)} within the searched caps (best ${pct(dual.bestP)})`
    : `${dual.best ? groups.map((g) => `${escapeHtml(nameOf(g))}: ${dual.best![g]}`).join(', ') : ''}
       — ${dual.extraSlots} slot${dual.extraSlots === 1 ? '' : 's'} beyond the ${baseline}-card minimum`;

  return `
    <p class="hint"><b>Best split of your current ${currentSpend} slots</b> (${groups.map((g) => escapeHtml(nameOf(g))).join(' + ')}):
    ${bestRow} → ${pct(alloc.bestP)}${alloc.exact ? '' : ' <span class="hint">(heuristic, not exhaustive)</span>'}</p>
    <p class="hint"><b>Fewest slots for ${pct(state.target)}:</b> ${dualRow}</p>`;
}

function clearViews(): void {
  $('status').innerHTML = '';
  $('summary').innerHTML = '';
  $('curve').innerHTML = '';
  $('table').innerHTML = '';
  $('grid').innerHTML = '';
  $('frontier').innerHTML = '';
}

function failQuery(msg: string): void {
  clearViews();
  $('status').innerHTML = `<span class="bad">${escapeHtml(msg)}</span>`;
}

function describeError(e: unknown): string {
  if (e instanceof ParseError) return `Parse error at ${e.pos}: ${e.message}`;
  if (e instanceof UnknownGroupError) return e.message;
  if (e instanceof QueryTooLargeError) return `Query too large: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

function renderStatus(res: ReturnType<typeof evaluate>, a: ReturnType<typeof analyze>): void {
  $('status').innerHTML = [
    `<b>${res.clauses}</b> clause${res.clauses === 1 ? '' : 's'}`,
    `<b>${res.terms}</b> inclusion–exclusion term${res.terms === 1 ? '' : 's'}`,
    res.monotone
      ? `<span class="ok">monotone</span> — more cards never hurt`
      : `<span class="flag">non-monotone</span> — has an upper bound, so P can fall`,
    `peak <b>${pct(a.maxP)}</b> at n=<b>${a.argmaxP}</b>`,
  ].join(' · ');
}

function turnSuffix(n: number): string {
  const turn = turnForCardsSeen(n, state.turnCfg);
  return turn === null ? '' : ` (turn ${turn})`;
}

function renderSummary(a: ReturnType<typeof analyze>): void {
  const t = pct(a.target);
  let line: string;
  if (a.windows.length === 0) {
    line = `<span class="flag">Never reaches ${t}.</span> Best is ${pct(a.maxP)} at ${a.argmaxP} cards${turnSuffix(a.argmaxP)}.`;
  } else if (a.monotone) {
    line = `Reaches ${t} at <b>${a.drawsNeeded}</b> cards drawn${turnSuffix(a.drawsNeeded!)}, and stays there.`;
  } else {
    const w = a.windows.map(([s, e]) => (s === e ? `${s}` : `${s}–${e}`)).join(', ');
    line = `P ≥ ${t} only for n ∈ {${w}} — a bounded window, because the query is capped above.`;
  }
  const knee = a.deltas[a.knee] ?? 0;
  const after = a.monotone
    ? 'Past that, every extra card buys less than the one before.'
    : `P turns over at n=${a.argmaxP}; past there extra cards actively hurt.`;
  $('summary').innerHTML =
    `<p>${line}</p><p class="hint">Steepest gain: card ${a.knee + 1} is worth ${signed(knee)}. ${after}</p>`;
}

// ── curve ────────────────────────────────────────────────────────────────────
function renderCurve(a: ReturnType<typeof analyze>, series: CurveSeries[]): void {
  const N = a.curve.length - 1;
  const W = 640, H = 200, PAD = 28;
  const x = (n: number) => PAD + (n / N) * (W - PAD - 8);
  const y = (p: number) => H - PAD - p * (H - PAD - 10);
  const pointsOf = (curve: Float64Array) =>
    Array.from(curve, (p, n) => `${x(n).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
  const gridLines = [0.25, 0.5, 0.75, 1].map((p) =>
    `<line x1="${PAD}" x2="${W - 8}" y1="${y(p)}" y2="${y(p)}" class="ax"/>
     <text x="2" y="${y(p) + 4}" class="lbl">${p * 100}%</text>`).join('');
  const ticks = tickValues(N).map((n) =>
    `<text x="${x(n)}" y="${H - 8}" class="lbl mid">${n}</text>`).join('');
  const targetLine = `<line x1="${PAD}" x2="${W - 8}" y1="${y(a.target)}" y2="${y(a.target)}" class="tgt"/>`;
  const marks = a.drawsNeeded !== null
    ? `<circle cx="${x(a.drawsNeeded)}" cy="${y(a.curve[a.drawsNeeded]!)}" r="4" class="hit"/>`
    : '';

  // Starting hand: vertical reference line, same n=openingHand cutoff the tables use.
  const hand = state.turnCfg.openingHand;
  const handLine = hand >= 0 && hand <= N
    ? `<line x1="${x(hand)}" x2="${x(hand)}" y1="8" y2="${H - PAD}" class="hand"/>
       <text x="${x(hand)}" y="10" class="lbl mid hand-lbl">hand</text>`
    : '';

  // Steepest gain — same point the per-draw table marks with "◂ steepest".
  const steepestN = a.knee + 1;
  const knee = steepestN >= 0 && steepestN <= N
    ? `<circle cx="${x(steepestN)}" cy="${y(a.curve[steepestN]!)}" r="4" class="knee"/>
       <text x="${x(steepestN)}" y="${y(a.curve[steepestN]!) - 8}" class="lbl mid knee-lbl">steepest</text>`
    : '';

  // Phantoms first (so the real curve always draws on top), farthest offset
  // first so +-1 layers over +-2 within the same group's color.
  const phantoms = series.filter((s) => s.offset !== null)
    .sort((p, q) => Math.abs(q.offset!) - Math.abs(p.offset!));
  const real = series.find((s) => s.offset === null)!;

  const phantomLines = phantoms.map((s) => {
    const opacity = Math.abs(s.offset!) === 1 ? 0.45 : 0.18;
    return `<polyline points="${pointsOf(s.curve)}" class="phantom" data-tip="${escapeAttr(s.composition)}"
      style="stroke:${s.color};opacity:${opacity}"/>`;
  }).join('');
  const realLine = `<polyline points="${pointsOf(real.curve)}" class="line" data-tip="${escapeAttr(real.composition)}"/>`;

  const legend = state.groups.map((g) =>
    `<span class="swatch"><i style="background:hsl(${hueFor(g.id)}deg 65% 58%)"></i>${escapeHtml(g.name)}</span>`
  ).join(' ');

  $('curve').innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" width="100%">${gridLines}${targetLine}${handLine}
      ${phantomLines}${realLine}${marks}${knee}${ticks}
      <text x="${W / 2}" y="${H - 8}" class="lbl mid dim">cards drawn</text></svg>
     <p class="hint">Faint lines: +-1/+-2 copies of each group, holding the rest fixed.
       ${legend}</p>
     <p class="hint" id="curveTip">Hover or tap a line to see the composition that produced it.</p>`;

  $('curve').querySelectorAll<SVGPolylineElement>('polyline[data-tip]').forEach((el) => {
    const show = () => { $('curveTip').textContent = el.dataset.tip ?? ''; };
    el.addEventListener('mouseenter', show);
    el.addEventListener('click', show);
  });
}

function tickValues(N: number): number[] {
  const step = N <= 20 ? 5 : N <= 60 ? 10 : 25;
  const out: number[] = [];
  for (let n = 0; n <= N; n += step) out.push(n);
  return out;
}

// ── per-draw table ───────────────────────────────────────────────────────────
function renderTable(a: ReturnType<typeof analyze>): void {
  const N = a.curve.length - 1;
  const start = Math.min(state.turnCfg.openingHand, N);
  const rows: string[] = [];
  for (let n = start; n <= N; n++) {
    const hit = a.curve[n]! >= a.target - 1e-12;
    const isKnee = n === a.knee + 1;
    const turn = turnForCardsSeen(n, state.turnCfg);
    rows.push(`<tr class="${hit ? 'hit' : ''}">
      <td>${n}</td>
      <td class="dim">${turn ?? ''}</td>
      <td>${pct(a.curve[n]!)}</td>
      <td class="dim">${n === start ? '' : signed(a.deltas[n - 1]!)}${isKnee ? ' ◂ steepest' : ''}</td>
    </tr>`);
  }
  $('table').innerHTML =
    `<table class="num"><thead><tr><th>drawn</th><th>turn${onPlaySuffix()}</th><th>P</th><th>ΔP per card</th></tr></thead>
     <tbody>${rows.join('')}</tbody></table>`;
}

// ── result view (chart vs table) ─────────────────────────────────────────────
function syncResultView(): void {
  document.querySelectorAll<HTMLButtonElement>('button.rview').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === state.resultView);
  });
  $('curve').style.display = state.resultView === 'chart' ? '' : 'none';
  $('tableWrap').style.display = state.resultView === 'table' ? '' : 'none';
}

// ── 2D grid: cards drawn × copies of one group ───────────────────────────────
function syncGridModeButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('button.gmode').forEach((el) => {
    el.classList.toggle('active', el.dataset.mode === state.gridMode);
  });
}

function renderGrid(): void {
  const g = state.groups.find((x) => x.id === state.gridGroup);
  if (!g) { $('grid').innerHTML = '<p class="hint">No group selected.</p>'; return; }

  const fixed = state.groups.filter((x) => x.id !== g.id).reduce((s, x) => s + x.count, 0);
  const kMax = Math.min(state.deckSize - fixed, 12);
  const nMax = Math.min(state.deckSize, state.gridMaxDraws);
  const ast = state.ast;
  if (!ast) { $('grid').innerHTML = ''; return; }
  if (state.turnCfg.openingHand > nMax) {
    $('grid').innerHTML = `<p class="hint flag">Starting hand size (${state.turnCfg.openingHand}) is
      past "max cards drawn" (${nMax}) — raise max draws to see any columns.</p>`;
    return;
  }
  const nStart = state.turnCfg.openingHand;

  // Compute every row's curve ONCE. dDraw reads adjacent entries of the same
  // curve for free; dCopy reads the same column from the row above — neither
  // needs extra DP calls beyond the kMax+1 we already needed for the values view.
  const curves: Array<Float64Array | null> = [];
  for (let k = 0; k <= kMax; k++) {
    const groups = state.groups.map((x) => (x.id === g.id ? { ...x, count: k } : x));
    try {
      const sizes = sizesOf(groups);
      curves.push(evaluate(state.deckSize, sizes, normalize(ast, sizes)).curve);
    } catch { curves.push(null); }
  }

  const cols = range(nStart, nMax);
  const header = `<tr><th class="corner">copies ↓ / drawn →</th>${
    cols.map((n) => `<th>${n}</th>`).join('')}</tr>`;

  // Diffs can be negative (non-monotone queries) and their typical magnitude
  // varies a lot by query, so scale color contrast to what's actually on
  // screen rather than a fixed range — otherwise a query whose biggest swing
  // is 3% renders as all-neutral against a scale built for 30% swings.
  let maxAbsDiff = 0;
  if (state.gridMode !== 'value') {
    for (let k = 0; k <= kMax; k++) {
      for (const n of cols) {
        const d = diffAt(curves, k, n, state.gridMode);
        if (d !== null) maxAbsDiff = Math.max(maxAbsDiff, Math.abs(d));
      }
    }
  }

  const rows: string[] = [];
  for (let k = 0; k <= kMax; k++) {
    const cells = cols.map((n) => {
      if (state.gridMode === 'value') {
        const curve = curves[k];
        if (!curve) return `<td class="na">—</td>`;
        const p = curve[n]!;
        return `<td style="background:${heat(p)}" title="${k} copies, ${n} drawn: ${pct(p)}">${(p * 100).toFixed(0)}</td>`;
      }
      const d = diffAt(curves, k, n, state.gridMode);
      if (d === null) return `<td class="na">—</td>`;
      const label = state.gridMode === 'dCopy' ? `${k - 1}\u2192${k} copies` : `${n - 1}\u2192${n} drawn`;
      return `<td style="background:${divHeat(d, maxAbsDiff)}" title="${label}: ${signed(d)}">${(d * 100).toFixed(1)}</td>`;
    }).join('');
    rows.push(`<tr><th>${k}${k === g.count ? ' ◂' : ''}</th>${cells}</tr>`);
  }

  const modeNote = state.gridMode === 'value'
    ? `P (%) as <b>${escapeHtml(g.name)}</b> copies and cards drawn both vary`
    : state.gridMode === 'dCopy'
    ? `Gain (percentage points) from running <b>one more copy of ${escapeHtml(g.name)}</b>
       — each cell is that row's P minus the row above's. Brighter = more return per slot spent
       there; that's where to look for the best place to add a copy.`
    : `Gain (percentage points) from <b>drawing one more card</b> — each cell is that column's P
       minus the column to its left. Shows where the deck's draws stop paying off, for any
       ${escapeHtml(g.name)} count.`;

  $('grid').innerHTML =
    `<p class="hint">${modeNote}
     (columns start at your ${state.turnCfg.openingHand}-card starting hand).
     The row marked ◂ is your current deck.</p>
     <table class="heat">${header}${rows.join('')}</table>`;
}

/** null when there's no adjacent cell to diff against (k=0 for dCopy, n=nStart for dDraw). */
function diffAt(
  curves: Array<Float64Array | null>,
  k: number,
  n: number,
  mode: 'dCopy' | 'dDraw',
): number | null {
  if (mode === 'dCopy') {
    if (k === 0) return null;
    const cur = curves[k], prev = curves[k - 1];
    if (!cur || !prev) return null;
    return cur[n]! - prev[n]!;
  }
  const curve = curves[k];
  if (!curve || n === 0) return null;
  return curve[n]! - curve[n - 1]!;
}

/** Diverging scale for differentials: negative -> warm, positive -> cool, 0 -> neutral. */
function divHeat(d: number, maxAbs: number): string {
  const neutral: [number, number, number] = [30, 33, 40];
  const pos: [number, number, number] = [56, 168, 140];
  const neg: [number, number, number] = [210, 90, 70];
  if (maxAbs <= 1e-12) return `rgb(${neutral.join(',')})`;
  const t = Math.max(0, Math.min(1, Math.abs(d) / maxAbs));
  const target = d >= 0 ? pos : neg;
  const c = neutral.map((v, i) => Math.round(v + (target[i]! - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function onPlaySuffix(): string {
  return state.turnCfg.onThePlay ? '' : ' (draw)';
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

/** Perceptual-ish dark→bright ramp. Deliberately not a rainbow. */
function heat(p: number): string {
  const stops: Array<[number, number, number]> = [
    [12, 14, 24], [38, 52, 108], [30, 110, 130], [56, 168, 110], [180, 210, 70], [250, 240, 160],
  ];
  const t = Math.max(0, Math.min(1, p)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t));
  const f = t - i;
  const [a, b] = [stops[i]!, stops[i + 1]!];
  const c = a.map((v, j) => Math.round(v + (b[j]! - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
const escapeAttr = (s: string) => escapeHtml(s).replace(/"/g, '&quot;');

// ── wiring ───────────────────────────────────────────────────────────────────
function init(): void {
  setQueryText(state.query); // populate state.ast before the first recompute()
  ($('deckSize') as HTMLInputElement).value = String(state.deckSize);
  ($('query') as HTMLTextAreaElement).value = state.query;
  ($('target') as HTMLInputElement).value = String(Math.round(state.target * 100));
  ($('maxDraws') as HTMLInputElement).value = String(state.gridMaxDraws);
  ($('openingHand') as HTMLInputElement).value = String(state.turnCfg.openingHand);
  ($('onThePlay') as HTMLInputElement).checked = state.turnCfg.onThePlay;

  ($('deckSize') as HTMLInputElement).oninput = (e) => {
    const v = parseInt((e.target as HTMLInputElement).value, 10);
    if (Number.isFinite(v) && v > 0 && v <= 1024) { state.deckSize = v; renderOthers(); recompute(); }
  };
  ($('query') as HTMLTextAreaElement).oninput = (e) => {
    setQueryText((e.target as HTMLTextAreaElement).value); recompute();
  };
  ($('target') as HTMLInputElement).oninput = (e) => {
    const v = parseFloat((e.target as HTMLInputElement).value);
    if (Number.isFinite(v) && v > 0 && v <= 100) { state.target = v / 100; recompute(); }
  };
  ($('maxDraws') as HTMLInputElement).oninput = (e) => {
    const v = parseInt((e.target as HTMLInputElement).value, 10);
    if (Number.isFinite(v) && v > 0) { state.gridMaxDraws = v; renderGrid(); }
  };
  ($('openingHand') as HTMLInputElement).oninput = (e) => {
    const v = parseInt((e.target as HTMLInputElement).value, 10);
    if (Number.isFinite(v) && v >= 0) {
      state.turnCfg = { ...state.turnCfg, openingHand: v };
      recompute();
    }
  };
  ($('onThePlay') as HTMLInputElement).onchange = (e) => {
    state.turnCfg = { ...state.turnCfg, onThePlay: (e.target as HTMLInputElement).checked };
    recompute();
  };
  ($('gridGroup') as HTMLSelectElement).onchange = (e) => {
    state.gridGroup = (e.target as HTMLSelectElement).value; renderGrid();
  };
  document.querySelectorAll<HTMLButtonElement>('button.gmode').forEach((el) => {
    el.onclick = () => {
      state.gridMode = el.dataset.mode as typeof state.gridMode;
      syncGridModeButtons();
      renderGrid();
    };
  });
  syncGridModeButtons();
  document.querySelectorAll<HTMLButtonElement>('button.rview').forEach((el) => {
    el.onclick = () => {
      state.resultView = el.dataset.view as typeof state.resultView;
      syncResultView();
    };
  });
  syncResultView();
  $('addGroup').onclick = () => {
    state.groups.push({ id: `g${seq++}`, name: `G${seq}`, count: 1 });
    renderDeck(); renderGridPicker(); recompute();
  };
  document.querySelectorAll<HTMLButtonElement>('button.dpreset').forEach((b) => {
    b.onclick = () => {
      state.deckSize = Number(b.dataset.n);
      ($('deckSize') as HTMLInputElement).value = String(state.deckSize);
      renderOthers();
      recompute();
      renderGrid();
    };
  });
  document.querySelectorAll<HTMLButtonElement>('button.preset').forEach((b) => {
    b.onclick = () => {
      state.target = Number(b.dataset.p);
      ($('target') as HTMLInputElement).value = String(Math.round(state.target * 100));
      recompute();
    };
  });
  document.querySelectorAll<HTMLButtonElement>('button.ex').forEach((b) => {
    b.onclick = () => {
      setQueryText(b.dataset.q!);
      ($('query') as HTMLTextAreaElement).value = state.query;
      recompute();
    };
  });

  renderDeck(); renderGridPicker(); recompute();
}

init();
