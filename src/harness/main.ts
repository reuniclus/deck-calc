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
import { compileFlat, decompileFlat, type Row, type Mode } from '../math/builder';
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
  builder: null as { mode: Mode; k: number; rows: Row[] } | null,
  builderUnavailable: false,
  target: 0.9,
  turnCfg: { ...DEFAULT_TURN_CONFIG } as TurnConfig,
  gridGroup: 'g0',
  gridMaxDraws: 20,
  /** value = raw P; dCopy = marginal gain from the next copy; dDraw = marginal gain from the next card drawn. */
  gridMode: 'value' as 'value' | 'dCopy' | 'dDraw',
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

function renderBuilder(): void {
  const box = $('builder');
  if (state.groups.length === 0) {
    box.innerHTML = '<p class="hint">Add a group first.</p>';
    return;
  }
  if (state.builderUnavailable) {
    box.innerHTML = `<p class="hint flag">Current query has real nesting (mixed AND/OR, or NOT of more than
       a single condition) — too complex for this picker. Text still works below.
       Your last builder state is kept in case you switch back.</p>`;
    return;
  }
  if (!state.builder) {
    box.innerHTML = `<p class="hint">No query yet.</p>`;
    return;
  }

  const b = state.builder;
  const groupOpts = (selected: string) => state.groups
    .map((g) => `<option value="${g.id}" ${g.id === selected ? 'selected' : ''}>${escapeHtml(g.name)}</option>`)
    .join('');

  const rowsHtml = b.rows.map((r, i) => {
    const cmp = cmpOf(r);
    return `<div class="brow" data-i="${i}">
      <button class="bneg ${r.neg ? 'on' : ''}" data-i="${i}" title="negate">${r.neg ? 'NOT' : 'not'}</button>
      <select class="bgroup" data-i="${i}">${groupOpts(r.g)}</select>
      <select class="bcmp" data-i="${i}">
        <option value="gte" ${cmp === 'gte' ? 'selected' : ''}>&ge;</option>
        <option value="lte" ${cmp === 'lte' ? 'selected' : ''}>&le;</option>
        <option value="eq" ${cmp === 'eq' ? 'selected' : ''}>=</option>
        <option value="range" ${cmp === 'range' ? 'selected' : ''}>range</option>
      </select>
      <input class="bnum1" data-i="${i}" type="number" min="0" value="${cmp === 'lte' ? r.hi : r.lo}" style="width:3.5rem">
      ${cmp === 'range' ? `<span class="hint">to</span><input class="bnum2" data-i="${i}" type="number" min="0" value="${r.hi}" style="width:3.5rem">` : ''}
      <button class="bdel" data-i="${i}">✕</button>
    </div>`;
  }).join('');

  box.innerHTML = `
    <div class="row" style="margin-bottom:.5rem">
      <select id="bmode">
        <option value="and" ${b.mode === 'and' ? 'selected' : ''}>all of these (AND)</option>
        <option value="or" ${b.mode === 'or' ? 'selected' : ''}>any of these (OR)</option>
        <option value="atLeastK" ${b.mode === 'atLeastK' ? 'selected' : ''}>at least N of these</option>
      </select>
      ${b.mode === 'atLeastK'
        ? `<input id="bk" type="number" min="1" max="${b.rows.length}" value="${b.k}" style="width:3.5rem">`
        : ''}
      <button id="baddRow">+ condition</button>
    </div>
    ${rowsHtml || '<p class="hint">No conditions yet — add one.</p>'}`;

  ($('bmode') as HTMLSelectElement).onchange = (e) => {
    state.builder!.mode = (e.target as HTMLSelectElement).value as Mode;
    if (state.builder!.mode === 'atLeastK') {
      state.builder!.k = Math.min(state.builder!.k || 1, state.builder!.rows.length || 1);
    }
    renderBuilder(); applyBuilder();
  };
  const bk = document.getElementById('bk') as HTMLInputElement | null;
  if (bk) bk.oninput = () => {
    const v = parseInt(bk.value, 10);
    if (Number.isFinite(v) && v >= 1) { state.builder!.k = v; applyBuilder(); }
  };
  $('baddRow').addEventListener('click', () => {
    state.builder!.rows.push({ g: state.groups[0]!.id, neg: false, lo: 1, hi: null });
    renderBuilder(); applyBuilder();
  });
  box.querySelectorAll<HTMLButtonElement>('.bneg').forEach((el) => {
    el.onclick = () => {
      const i = Number(el.dataset.i);
      state.builder!.rows[i]!.neg = !state.builder!.rows[i]!.neg;
      renderBuilder(); applyBuilder();
    };
  });
  box.querySelectorAll<HTMLSelectElement>('.bgroup').forEach((el) => {
    el.onchange = () => {
      const i = Number(el.dataset.i);
      state.builder!.rows[i]!.g = el.value;
      applyBuilder();
    };
  });
  box.querySelectorAll<HTMLSelectElement>('.bcmp').forEach((el) => {
    el.onchange = () => {
      const i = Number(el.dataset.i);
      const row = state.builder!.rows[i]!;
      const v = el.value as 'gte' | 'lte' | 'eq' | 'range';
      const g = state.groups.find((x) => x.id === row.g);
      const K = g?.count ?? 1;
      if (v === 'gte') { row.lo = Math.max(1, row.lo || 1); row.hi = null; }
      else if (v === 'lte') { row.hi = row.hi ?? K; row.lo = 0; }
      else if (v === 'eq') { const n = row.lo || 1; row.lo = n; row.hi = n; }
      else { row.hi = row.hi ?? K; row.lo = Math.min(row.lo || 0, row.hi); }
      renderBuilder(); applyBuilder();
    };
  });
  box.querySelectorAll<HTMLInputElement>('.bnum1').forEach((el) => {
    el.oninput = () => {
      const i = Number(el.dataset.i);
      const row = state.builder!.rows[i]!;
      const v = parseInt(el.value, 10);
      if (!Number.isFinite(v) || v < 0) return;
      const cmp = cmpOf(row);
      if (cmp === 'lte') row.hi = v;
      else if (cmp === 'eq') { row.lo = v; row.hi = v; }
      else row.lo = v; // gte or range's lo
      applyBuilder();
    };
  });
  box.querySelectorAll<HTMLInputElement>('.bnum2').forEach((el) => {
    el.oninput = () => {
      const i = Number(el.dataset.i);
      const v = parseInt(el.value, 10);
      if (Number.isFinite(v) && v >= 0) { state.builder!.rows[i]!.hi = v; applyBuilder(); }
    };
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
  renderCurve(a, computePhantomCurves(state.ast));
  renderTable(a);
  renderGrid();
  renderFrontier(dnf, a, sizes);
}

/**
 * P(n) for the swept group ("vary copies of", shared with the grid) at
 * +-1/+-2 copies, holding every other group fixed. Purely illustrative context
 * for the main curve — "what if I ran one more/fewer" — not a separate query.
 */
function computePhantomCurves(
  ast: Expr,
): Array<{ offset: number; curve: Float64Array }> {
  const g = state.groups.find((x) => x.id === state.gridGroup);
  if (!g) return [];
  const out: Array<{ offset: number; curve: Float64Array }> = [];
  for (const offset of [-2, -1, 1, 2]) {
    const count = g.count + offset;
    if (count < 0) continue;
    const groups = state.groups.map((x) => (x.id === g.id ? { ...x, count } : x));
    try {
      const s = sizesOf(groups);
      out.push({ offset, curve: evaluate(state.deckSize, s, normalize(ast, s)).curve });
    } catch {
      // deck too small to hold this many copies, or some other constraint violation — skip it
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
function renderCurve(
  a: ReturnType<typeof analyze>,
  phantoms: Array<{ offset: number; curve: Float64Array }> = [],
): void {
  const N = a.curve.length - 1;
  const W = 640, H = 200, PAD = 28;
  const x = (n: number) => PAD + (n / N) * (W - PAD - 8);
  const y = (p: number) => H - PAD - p * (H - PAD - 10);
  const pointsOf = (curve: Float64Array) =>
    Array.from(curve, (p, n) => `${x(n).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
  const pts = pointsOf(a.curve);
  const gridLines = [0.25, 0.5, 0.75, 1].map((p) =>
    `<line x1="${PAD}" x2="${W - 8}" y1="${y(p)}" y2="${y(p)}" class="ax"/>
     <text x="2" y="${y(p) + 4}" class="lbl">${p * 100}%</text>`).join('');
  const ticks = tickValues(N).map((n) =>
    `<text x="${x(n)}" y="${H - 8}" class="lbl mid">${n}</text>`).join('');
  const targetLine = `<line x1="${PAD}" x2="${W - 8}" y1="${y(a.target)}" y2="${y(a.target)}" class="tgt"/>`;
  const marks = a.drawsNeeded !== null
    ? `<circle cx="${x(a.drawsNeeded)}" cy="${y(a.curve[a.drawsNeeded]!)}" r="4" class="hit"/>`
    : '';
  // Closer offsets (+-1) more opaque than farther ones (+-2); drawn UNDER the
  // real curve so the actual deck's line always reads as the primary one.
  const phantomLines = phantoms
    .slice()
    .sort((p, q) => Math.abs(q.offset) - Math.abs(p.offset)) // draw +-2 first, +-1 on top of it
    .map((p) => `<polyline points="${pointsOf(p.curve)}" class="phantom mag${Math.abs(p.offset)}"/>`)
    .join('');
  const g = state.groups.find((x) => x.id === state.gridGroup);
  const legend = phantoms.length > 0 && g
    ? `<p class="hint">Faint lines: <b>${escapeHtml(g.name)}</b> at ${
        phantoms.slice().sort((p, q) => p.offset - q.offset)
          .map((p) => (p.offset > 0 ? `+${p.offset}` : p.offset)).join(', ')
      } compared to its current ${g.count} copies — closer counts are more solid.</p>`
    : '';
  $('curve').innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" width="100%">${gridLines}${targetLine}
      ${phantomLines}
      <polyline points="${pts}" class="line"/>${marks}${ticks}
      <text x="${W / 2}" y="${H - 8}" class="lbl mid dim">cards drawn</text></svg>${legend}`;
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

// ── 2D grid: cards drawn × copies of one group ───────────────────────────────
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
  ($('gridMode') as HTMLSelectElement).value = state.gridMode;
  ($('gridMode') as HTMLSelectElement).onchange = (e) => {
    state.gridMode = (e.target as HTMLSelectElement).value as typeof state.gridMode;
    renderGrid();
  };
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
