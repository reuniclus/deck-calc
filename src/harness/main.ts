/**
 * Barebones dev harness. Plain DOM on purpose — this is the window onto the math
 * layer while the real React UI is still unwritten. Imports the same modules the
 * app will, so it cannot drift from the tested code.
 */
import { parseQuery, ParseError } from '../math/parse';
import { normalize } from '../math/normalize';
import { evaluate } from '../math/evaluate';
import { analyze } from '../math/analyze';
import { QueryTooLargeError, UnknownGroupError, type Sizes } from '../math/expr';

interface Group { id: string; name: string; count: number }

const state = {
  deckSize: 40,
  groups: [
    { id: 'g0', name: 'A', count: 4 },
    { id: 'g1', name: 'B', count: 3 },
  ] as Group[],
  query: 'A>=1 & B>=1',
  target: 0.9,
  gridGroup: 'g0',
  gridMaxDraws: 20,
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
    el.oninput = () => { setGroup(el.dataset.id!, { name: el.value }); recompute(); };
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
    return;
  }
  const dupes = state.groups.filter((g, i) =>
    state.groups.findIndex((h) => h.name.trim().toLowerCase() === g.name.trim().toLowerCase()) !== i);
  if (dupes.length) {
    warn.textContent = `Duplicate group name: "${dupes[0]!.name}". Names must be unique — groups are disjoint.`;
    warn.className = 'warn bad';
    return;
  }
  warn.textContent = '';
  warn.className = 'warn';

  const sizes = sizesOf(state.groups);
  let res: ReturnType<typeof evaluate>;
  try {
    const dnf = normalize(parseQuery(state.query, resolverFor(state.groups)), sizes);
    res = evaluate(N, sizes, dnf);
  } catch (e) {
    $('status').innerHTML = `<span class="bad">${escapeHtml(describeError(e))}</span>`;
    $('summary').innerHTML = '';
    $('curve').innerHTML = '';
    $('table').innerHTML = '';
    $('grid').innerHTML = '';
    return;
  }

  const a = analyze(res.curve, state.target, res.monotone);
  renderStatus(res, a);
  renderSummary(a);
  renderCurve(a);
  renderTable(a);
  renderGrid();
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

function renderSummary(a: ReturnType<typeof analyze>): void {
  const t = pct(a.target);
  let line: string;
  if (a.windows.length === 0) {
    line = `<span class="flag">Never reaches ${t}.</span> Best is ${pct(a.maxP)} at ${a.argmaxP} cards.`;
  } else if (a.monotone) {
    line = `Reaches ${t} at <b>${a.drawsNeeded}</b> cards drawn, and stays there.`;
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
function renderCurve(a: ReturnType<typeof analyze>): void {
  const N = a.curve.length - 1;
  const W = 640, H = 200, PAD = 28;
  const x = (n: number) => PAD + (n / N) * (W - PAD - 8);
  const y = (p: number) => H - PAD - p * (H - PAD - 10);
  const pts = Array.from(a.curve, (p, n) => `${x(n).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
  const gridLines = [0.25, 0.5, 0.75, 1].map((p) =>
    `<line x1="${PAD}" x2="${W - 8}" y1="${y(p)}" y2="${y(p)}" class="ax"/>
     <text x="2" y="${y(p) + 4}" class="lbl">${p * 100}%</text>`).join('');
  const ticks = tickValues(N).map((n) =>
    `<text x="${x(n)}" y="${H - 8}" class="lbl mid">${n}</text>`).join('');
  const targetLine = `<line x1="${PAD}" x2="${W - 8}" y1="${y(a.target)}" y2="${y(a.target)}" class="tgt"/>`;
  const marks = a.drawsNeeded !== null
    ? `<circle cx="${x(a.drawsNeeded)}" cy="${y(a.curve[a.drawsNeeded]!)}" r="4" class="hit"/>`
    : '';
  $('curve').innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" width="100%">${gridLines}${targetLine}
      <polyline points="${pts}" class="line"/>${marks}${ticks}
      <text x="${W / 2}" y="${H - 8}" class="lbl mid dim">cards drawn</text></svg>`;
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
  const rows: string[] = [];
  for (let n = 0; n <= N; n++) {
    const hit = a.curve[n]! >= a.target - 1e-12;
    const isKnee = n === a.knee + 1;
    rows.push(`<tr class="${hit ? 'hit' : ''}">
      <td>${n}</td>
      <td>${pct(a.curve[n]!)}</td>
      <td class="dim">${n === 0 ? '' : signed(a.deltas[n - 1]!)}${isKnee ? ' ◂ steepest' : ''}</td>
    </tr>`);
  }
  $('table').innerHTML =
    `<table class="num"><thead><tr><th>drawn</th><th>P</th><th>ΔP per card</th></tr></thead>
     <tbody>${rows.join('')}</tbody></table>`;
}

// ── 2D grid: cards drawn × copies of one group ───────────────────────────────
function renderGrid(): void {
  const g = state.groups.find((x) => x.id === state.gridGroup);
  if (!g) { $('grid').innerHTML = '<p class="hint">No group selected.</p>'; return; }

  const fixed = state.groups.filter((x) => x.id !== g.id).reduce((s, x) => s + x.count, 0);
  const kMax = Math.min(state.deckSize - fixed, 12);
  const nMax = Math.min(state.deckSize, state.gridMaxDraws);
  const resolve = resolverFor(state.groups);

  const header = `<tr><th class="corner">copies ↓ / drawn →</th>${
    range(0, nMax).map((n) => `<th>${n}</th>`).join('')}</tr>`;

  const rows: string[] = [];
  for (let k = 0; k <= kMax; k++) {
    const groups = state.groups.map((x) => (x.id === g.id ? { ...x, count: k } : x));
    let curve: Float64Array | null = null;
    try {
      const sizes = sizesOf(groups);
      curve = evaluate(state.deckSize, sizes,
        normalize(parseQuery(state.query, resolve), sizes)).curve;
    } catch { curve = null; }
    const cells = range(0, nMax).map((n) => {
      if (!curve) return `<td class="na">—</td>`;
      const p = curve[n]!;
      return `<td style="background:${heat(p)}" title="${k} copies, ${n} drawn">${(p * 100).toFixed(0)}</td>`;
    }).join('');
    rows.push(`<tr><th>${k}${k === g.count ? ' ◂' : ''}</th>${cells}</tr>`);
  }
  $('grid').innerHTML =
    `<p class="hint">P (%) as <b>${escapeHtml(g.name)}</b> copies and cards drawn both vary.
     The row marked ◂ is your current deck. Everything else holds the rest of the deck fixed,
     trading cards against <i>others</i>.</p>
     <table class="heat">${header}${rows.join('')}</table>`;
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
  ($('deckSize') as HTMLInputElement).value = String(state.deckSize);
  ($('query') as HTMLTextAreaElement).value = state.query;
  ($('target') as HTMLInputElement).value = String(Math.round(state.target * 100));
  ($('maxDraws') as HTMLInputElement).value = String(state.gridMaxDraws);

  ($('deckSize') as HTMLInputElement).oninput = (e) => {
    const v = parseInt((e.target as HTMLInputElement).value, 10);
    if (Number.isFinite(v) && v > 0 && v <= 1024) { state.deckSize = v; renderOthers(); recompute(); }
  };
  ($('query') as HTMLTextAreaElement).oninput = (e) => {
    state.query = (e.target as HTMLTextAreaElement).value; recompute();
  };
  ($('target') as HTMLInputElement).oninput = (e) => {
    const v = parseFloat((e.target as HTMLInputElement).value);
    if (Number.isFinite(v) && v > 0 && v <= 100) { state.target = v / 100; recompute(); }
  };
  ($('maxDraws') as HTMLInputElement).oninput = (e) => {
    const v = parseInt((e.target as HTMLInputElement).value, 10);
    if (Number.isFinite(v) && v > 0) { state.gridMaxDraws = v; renderGrid(); }
  };
  ($('gridGroup') as HTMLSelectElement).onchange = (e) => {
    state.gridGroup = (e.target as HTMLSelectElement).value; renderGrid();
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
      state.query = b.dataset.q!;
      ($('query') as HTMLTextAreaElement).value = state.query;
      recompute();
    };
  });

  renderDeck(); renderGridPicker(); recompute();
}

init();
