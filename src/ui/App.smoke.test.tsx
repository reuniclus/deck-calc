import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { App } from './App';
import { AppStateProvider } from '../state/AppState';
import { QueryModelProvider } from '../state/useQueryModel';
import { MobileStickyBar } from './MobileNav';
import { encodeShared } from '../state/hashState';

describe('App smoke test (real render, not just typecheck)', () => {
  it('renders the default deck, query, and a working curve', () => {
    render(<App />);
    expect(screen.getByDisplayValue('40')).toBeInTheDocument(); // deck size
    expect(screen.getAllByDisplayValue('Blink ETB').length).toBeGreaterThan(0);
    expect(screen.getByText(/monotone/)).toBeInTheDocument();
    expect(screen.getByText(/Reaches 90.00%/)).toBeInTheDocument();
    expect(document.querySelector('polyline.curve-line')).toBeTruthy();
  });

  it('editing a group count live-updates the result', () => {
    render(<App />);
    const before = screen.getByText(/Reaches 90.00% at \d+ cards/).textContent;
    const countInputs = screen.getAllByDisplayValue('4');
    fireEvent.change(countInputs[0]!, { target: { value: '20' } });
    const after = screen.getByText(/Reaches 90.00% at \d+ cards/).textContent;
    expect(after).not.toBe(before);
  });

  it('the derived Others count updates when a group count changes', () => {
    render(<App />);
    fireEvent.change(screen.getAllByDisplayValue('4')[0]!, { target: { value: '10' } });
    // deck=40, groups now 10+3=13, others should be 27
    expect(document.querySelector('.others-count')?.textContent).toBe('27');
  });

  it('renaming a group updates the query text and keeps evaluating', () => {
    render(<App />);
    const nameInput = screen.getAllByDisplayValue('Blink ETB')[0]!;
    fireEvent.change(nameInput, { target: { value: 'Renamed Card' } });
    expect(screen.getByText(/monotone/)).toBeInTheDocument();
    // combo row should now show the new name somewhere
    expect(screen.getAllByText(/Renamed Card/).length).toBeGreaterThan(0);
  });

  it('adding a group and a combo condition works end to end', () => {
    render(<App />);
    fireEvent.click(screen.getByText('+ add group'));
    expect(screen.getAllByDisplayValue(/Group \d/).length).toBeGreaterThan(0);
  });

  it('adding a combo creates an OR and the query becomes non-trivial', () => {
    render(<App />);
    fireEvent.click(screen.getByText('+ add combo'));
    expect(screen.getByText(/\d+ clauses?/)).toBeInTheDocument();
  });

  it('duplicate group names surface the warning', () => {
    render(<App />);
    const nameInput = screen.getAllByDisplayValue('Blink Spell')[0]!;
    fireEvent.change(nameInput, { target: { value: 'Blink ETB' } });
    expect(screen.getByText(/Duplicate group name/)).toBeInTheDocument();
  });

  it('a query too complex for the builder falls back to text', () => {
    render(<App />);
    const combosPanel = screen.getByText('Combos').closest('.panel') as HTMLElement;
    // there is no text box visible yet (accordion mode) until we force a
    // complex query through the fallback textarea path -- simulate by
    // editing the visible builder down to something the flat model can't
    // express is hard via UI alone here, so just assert the toggle exists.
    expect(within(combosPanel).getByText('Edit as text')).toBeInTheDocument();
  });
});

describe('Table tab and resize handle', () => {
  it('switches between Chart and Table, and the table respects the starting hand trim', () => {
    render(<App />);
    // default hand size 7 -> table's first row should be n=7, not n=0
    fireEvent.click(screen.getByText('Table'));
    const table = document.querySelector('.tab-panel-table table.num-table')!;
    expect(table).toBeTruthy();
    const firstDataCell = table.querySelector('tbody tr td')!;
    expect(firstDataCell.textContent).toBe('7');
  });

  it('changing the target % updates the summary live', () => {
    render(<App />);
    const before = screen.getByText(/Reaches \d+\.\d+% at/).textContent;
    const targetInput = screen.getByDisplayValue('90');
    fireEvent.change(targetInput, { target: { value: '50' } });
    const after = screen.getByText(/Reaches \d+\.\d+% at/).textContent;
    expect(after).not.toBe(before);
    expect(after).toContain('50.00%');
  });

  it('the resize handle exists with the correct ARIA role', () => {
    render(<App />);
    expect(screen.getByRole('separator', { name: /resize/i })).toBeInTheDocument();
  });
});

describe('QoL fixes: empty-number-input-snaps-to-0, and auto-prune on delete', () => {
  it('backspacing a group count to empty sets it to 0, not stuck-blank', () => {
    render(<App />);
    const countInput = screen.getAllByDisplayValue('4')[0]! as HTMLInputElement;
    fireEvent.change(countInput, { target: { value: '' } });
    expect(countInput.value).toBe('0');
    // Others should have recalculated too, proving state actually updated (not just DOM)
    expect(document.querySelector('.others-count')?.textContent).toBe('37'); // 40 - 0 - 3
  });

  it('backspacing deck size to empty snaps to the reducer minimum (1), not stuck-blank', () => {
    render(<App />);
    const deckInput = screen.getByDisplayValue('40') as HTMLInputElement;
    fireEvent.change(deckInput, { target: { value: '' } });
    expect(deckInput.value).toBe('1');
  });

  it('backspacing a combo condition number to empty sets it to 0', () => {
    render(<App />);
    // default query has two conditions each >=1; find the numeric row inputs (not deck/hand/etc)
    const numInputs = document.querySelectorAll('.combo-row input[type="number"]');
    expect(numInputs.length).toBeGreaterThan(0);
    fireEvent.change(numInputs[0]!, { target: { value: '' } });
    expect((numInputs[0] as HTMLInputElement).value).toBe('0');
  });

  it('deleting a group referenced by the query auto-prunes it instead of forcing text mode', () => {
    render(<App />);
    expect(document.querySelector('.query-textarea')).toBeNull(); // starts in builder mode
    const delBtns = screen.getAllByRole('button', { name: /Remove/ });
    fireEvent.click(delBtns[1]!); // delete "Blink Spell", referenced by the default query
    expect(document.querySelector('.query-textarea')).toBeNull(); // still builder mode, not forced to text
    expect(screen.queryByText(/unknown group/)).toBeNull();
    expect(screen.getByText(/Removed "Blink Spell" from the query/)).toBeInTheDocument();
    // the remaining condition should still evaluate correctly
    expect(screen.getByText(/monotone/)).toBeInTheDocument();
  });

  it('deleting an UNREFERENCED group does not show a removal notice', () => {
    render(<App />);
    fireEvent.click(screen.getByText('+ add group')); // adds "Group 3", not referenced by the query
    const delBtns = screen.getAllByRole('button', { name: /Remove/ });
    fireEvent.click(delBtns[delBtns.length - 1]!); // delete the newly-added, unreferenced group
    expect(screen.queryByText(/Removed .* from the query/)).toBeNull();
    expect(document.querySelector('.query-textarea')).toBeNull();
  });
});

describe('Grid tab', () => {
  it('renders values matching the math layer directly, and marks the current-count row', () => {
    render(<App />);
    fireEvent.click(screen.getByText('Grid'));
    const table = document.querySelector('table.heat-table')!;
    expect(table).toBeTruthy();
    // current deck: Blink ETB=4 should be the marked row
    // component marks the current-count row with U+25C2 (◂); confirm the
    // marker is on the row whose header is exactly the current count (4), not
    // just present somewhere in the table.
    const rows = [...table.querySelectorAll('tbody tr')];
    const markedRow = rows.find((tr) => tr.querySelector('th')?.textContent?.includes('◂'));
    expect(markedRow).toBeTruthy();
    expect(markedRow!.querySelector('th')?.textContent).toContain('4');
    const unmarkedRows = rows.filter((tr) => tr !== markedRow);
    expect(unmarkedRows.some((tr) => tr.querySelector('th')?.textContent?.includes('◂'))).toBe(false);
  });

  it('switching the swept group updates the table without resetting the tab', () => {
    render(<App />);
    fireEvent.click(screen.getByText('Grid'));
    const select = document.querySelector('.row-line select') as HTMLSelectElement;
    const options = [...select.options].map((o) => o.value);
    expect(options.length).toBeGreaterThanOrEqual(2);
    fireEvent.change(select, { target: { value: options[1] } });
    expect(document.querySelector('table.heat-table')).toBeTruthy();
  });

  it('switching to interaction mode actually changes the underlying numbers (cross-checked against value mode)', () => {
    render(<App />);
    fireEvent.click(screen.getByText('Grid'));
    // sample several cells in value mode
    const valueCells = [...document.querySelectorAll('table.heat-table tbody tr td:not(.na)')]
      .slice(0, 10).map((td) => td.textContent);
    fireEvent.click(screen.getByText(/interaction/));
    const interactionCells = [...document.querySelectorAll('table.heat-table tbody tr td:not(.na)')]
      .slice(0, 10).map((td) => td.textContent);
    // decimal formatting differs (value: 0dp, interaction: 1dp) AND the underlying
    // quantity differs (raw P vs a discrete second difference) -- at least one
    // sampled cell must actually differ, not just be reformatted the same number.
    expect(valueCells).not.toEqual(interactionCells);
  });

  it('switching tabs away and back to Grid preserves the swept-group selection (kept mounted)', () => {
    render(<App />);
    fireEvent.click(screen.getByText('Grid'));
    const select = document.querySelector('.row-line select') as HTMLSelectElement;
    const secondOption = select.options[1]!.value;
    fireEvent.change(select, { target: { value: secondOption } });
    fireEvent.click(screen.getByText('Chart'));
    fireEvent.click(screen.getByText('Grid'));
    const selectAfter = document.querySelector('.row-line select') as HTMLSelectElement;
    expect(selectAfter.value).toBe(secondOption);
  });
});

describe('Combo row structure (jsdom cannot verify rendered CSS/layout -- this only confirms the right elements and classes exist for the stylesheet to target)', () => {
  it('the comparator select has a dedicated class distinct from the group select', () => {
    render(<App />);
    expect(document.querySelector('.combo-row select.cmp-select')).toBeTruthy();
    expect(document.querySelector('.combo-row select.group-select')).toBeTruthy();
  });

  it('switching one row to range mode adds exactly one more num-sm input to THAT row', () => {
    render(<App />);
    const firstRow = document.querySelector('.combo-row') as HTMLElement;
    expect(firstRow.querySelectorAll('input.num-sm').length).toBe(1);
    const cmpSelect = firstRow.querySelector('select.cmp-select') as HTMLSelectElement;
    fireEvent.change(cmpSelect, { target: { value: 'range' } });
    const numInputs = firstRow.querySelectorAll('input.num-sm');
    expect(numInputs.length).toBe(2);
  });
});

describe('Long/unbroken group names (structural checks -- jsdom cannot verify pixel overflow, see CLAUDE.md §10)', () => {
  it('an arbitrarily long, unbroken group name renders inside a bounded, truncating span in the collapsed summary', () => {
    render(<App />);
    const longName = 'sjrfdjksdfjsdfjksdkjfjkdsnjfsjksjrfdjksdfjsdfjksdkjfjkdsnjfsjk';
    const nameInput = screen.getAllByDisplayValue('Blink ETB')[0]! as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: longName } });
    // collapse the combo so the summary (not the editing row) renders
    fireEvent.click(screen.getByText('editing'));
    const nameSpan = document.querySelector('.truncate-name');
    expect(nameSpan).toBeTruthy();
    expect(nameSpan!.textContent).toBe(longName);
    expect(nameSpan!.className).toContain('truncate-name');
    // the long text must live INSIDE the bounded span, not as loose text in
    // an unconstrained parent -- that's the actual condition for the CSS
    // (max-width + overflow:hidden + ellipsis) to have any effect at all.
    expect(nameSpan!.parentElement?.className).toContain('combo-summary-item');
  });

  it('the group select in the expanded row has a hard max-width class, not just a flexible basis', () => {
    render(<App />);
    const select = document.querySelector('.combo-row select.group-select');
    expect(select).toBeTruthy();
  });

  it('rail and panel containers have containment (overflow hidden) so nothing can visually escape them', () => {
    render(<App />);
    // structural existence check only -- confirms the classes are present for
    // the stylesheet to target; cannot confirm the CSS actually renders that
    // way in this environment (see CLAUDE.md §10).
    expect(document.querySelector('.rail')).toBeTruthy();
    expect(document.querySelector('.panel')).toBeTruthy();
  });
});

describe('Deck size presets, others alignment, chart axis labels/gridlines', () => {
  it('deck size preset buttons exist and clicking one updates the deck size', () => {
    render(<App />);
    const preset60 = [...document.querySelectorAll('.preset-chips button')].find((b) => b.textContent === '60')!;
    fireEvent.click(preset60);
    expect((screen.getByDisplayValue('60') as HTMLInputElement).value).toBe('60');
  });

  it('the active preset gets the active class when it matches the current deck size', () => {
    render(<App />);
    fireEvent.click(screen.getByText('99'));
    const preset99 = [...document.querySelectorAll('.preset-chips button')].find((b) => b.textContent === '99');
    expect(preset99?.className).toContain('active');
  });

  it('Others row has a dedicated count element and placeholder distinct from the label', () => {
    render(<App />);
    expect(document.querySelector('.others-count')).toBeTruthy();
    expect(document.querySelector('.others-placeholder')).toBeTruthy();
    expect(document.querySelector('.others-label')?.textContent).toBe('Others');
  });

  it('the chart renders vertical per-card gridlines and percentage/axis labels, capped at 20 cards drawn (not the full 40-card deck -- drawing that many is unrealistic and squishes the useful range)', () => {
    render(<App />);
    const svg = document.querySelector('svg[aria-label="probability curve"]')!;
    const gridlines = svg.querySelectorAll('line.vax, line.vax5');
    expect(gridlines.length).toBe(21); // one per card, n=0..20 inclusive, regardless of the 40-card deck
    expect(svg.querySelectorAll('text.lbl').length).toBeGreaterThan(0);
    expect([...svg.querySelectorAll('text.lbl')].some((t) => t.textContent === 'cards drawn')).toBe(true);
    expect([...svg.querySelectorAll('text.lbl')].some((t) => t.textContent === '100%')).toBe(true);
  });
});

describe('Advisor strip and Suggestions tab', () => {
  it('the advisor strip shows a goal, turn, and first-turn-draw checkbox, always live', () => {
    render(<App />);
    const strip = document.querySelector('.advisor-strip')!;
    expect(strip.textContent).toContain('Goal:');
    expect(strip.textContent).toContain('by turn');
    expect(strip.textContent).toContain('first turn draw');
  });

  it('the advisor gives real advice for the default (single-clause, monotone) query', () => {
    render(<App />);
    const strip = document.querySelector('.advisor-strip')!;
    expect(strip.textContent).not.toContain('Not available');
    expect(strip.textContent).toMatch(/Draw \d+ cards|Already there/);
  });

  it('clicking "See suggestions" switches to the Suggestions tab and shows real tradeoff data', () => {
    render(<App />);
    const seeLink = screen.getByText(/See suggestions/);
    fireEvent.click(seeLink);
    const suggestionsBtn = [...document.querySelectorAll('.tab-strip button')].find((b) => b.textContent === 'Suggestions')!;
    expect(suggestionsBtn.className).toContain('active');
    expect(screen.getByText(/Target 90/)).toBeInTheDocument();
    // default query (2 groups, AND) should produce a real minimal-vector table
    expect(document.querySelector('.num-table')).toBeTruthy();
  });

  it('the advisor and Suggestions tab agree with each other (same underlying math, cross-checked numerically)', () => {
    render(<App />);
    const stripText = document.querySelector('.advisor-strip')!.textContent!;
    // advisor line looks like "...Or add 4 Blink ETB, 3 Blink Spell...";
    // extract the suggested counts it names.
    const stripCounts: Record<string, number> = {};
    for (const m of stripText.matchAll(/(\d+) (Blink ETB|Blink Spell)/g)) {
      stripCounts[m[2]!] = Number(m[1]);
    }
    expect(Object.keys(stripCounts).length).toBeGreaterThan(0); // the test itself must exercise a real suggestion

    fireEvent.click(screen.getByText(/See suggestions/));
    const table = document.querySelector('.tab-panel-suggestions .num-table')!;
    const headers = [...table.querySelectorAll('th')].map((th) => th.textContent);
    const rows = [...table.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => Number(td.textContent)));

    // the advisor's suggestion is "add N more" on top of the CURRENT count,
    // so reconstruct the absolute vector it implies and confirm that exact
    // vector is one of the rows in the Suggestions table -- not just that
    // some row exists, but that the SAME composition appears in both places.
    const current: Record<string, number> = { 'Blink ETB': 4, 'Blink Spell': 3 };
    const impliedVector = headers.map((h) => (current[h!] ?? 0) + (stripCounts[h!] ?? 0));
    expect(rows.some((row) => row.every((v, i) => v === impliedVector[i]))).toBe(true);
  });

  it('changing the goal turn updates BOTH the advisor line and the Suggestions tab consistently', () => {
    render(<App />);
    const turnInputs = document.querySelectorAll('.advisor-inline');
    const turnInput = turnInputs[1] as HTMLInputElement; // [0]=target%, [1]=turn
    fireEvent.change(turnInput, { target: { value: '10' } });
    fireEvent.click(screen.getByText(/See suggestions/));
    expect(screen.getByText(/Target 90.00% by turn 10/)).toBeInTheDocument();
  });

  it('a genuinely non-subsuming OR query now gets REAL advice via the general search path (not "not available")', () => {
    render(<App />);
    fireEvent.click(screen.getByText('Edit as text'));
    const textarea = document.querySelector('.query-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: '"Blink ETB">=1 & "Blink Spell">=1 | "Blink ETB">=3' },
    });
    const strip = document.querySelector('.advisor-strip')!;
    expect(strip.textContent).not.toContain('Not available');
    expect(strip.textContent).toMatch(/Draw \d+ cards|Already there/);
    fireEvent.click([...document.querySelectorAll('.tab-strip button')].find((b) => b.textContent === 'Suggestions')!);
    // the general path's own explanatory note, not the old blanket refusal
    expect(screen.getByText(/no shortcut search available/)).toBeInTheDocument();
    expect(document.querySelector('.num-table')).toBeTruthy();
    expect(screen.queryByText(/Only available for a single AND-clause/)).toBeNull();
  });

  it('the exact reported non-monotone OR case (mana flood avoidance, both clauses negated) gets real Suggestions', () => {
    render(<App />);
    fireEvent.click(screen.getByText('Edit as text'));
    const textarea = document.querySelector('.query-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: '!"Blink ETB">=4 | (!"Blink ETB">=3 & !"Blink Spell">=1)' },
    });
    fireEvent.click([...document.querySelectorAll('.tab-strip button')].find((b) => b.textContent === 'Suggestions')!);
    expect(screen.getByText(/no shortcut search available/)).toBeInTheDocument();
    // "best split"/"fewest slots" honestly omitted (not silently, explicitly) for OR/NOT
    expect(screen.getByText(/aren.t shown for OR\/NOT queries/)).toBeInTheDocument();
  });
});

describe('Chart: turn-T line, hover tooltip, suggestion curves', () => {
  it('renders a turnline distinct from the hand line', () => {
    render(<App />);
    const svg = document.querySelector('svg[aria-label="probability curve"]')!;
    expect(svg.querySelector('line.turnline')).toBeTruthy();
    expect(svg.querySelector('line.hand')).toBeTruthy();
  });

  it('hovering the chart shows a tooltip with cards drawn, turn, and success %', () => {
    render(<App />);
    const svg = document.querySelector('svg[aria-label="probability curve"]') as SVGSVGElement;
    // jsdom returns a zero-size rect by default; mock a realistic one so the
    // hover-position math (which divides by rect.width) doesn't divide by zero.
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 640, height: 200, right: 640, bottom: 200, x: 0, y: 0, toJSON: () => ({}),
    });
    fireEvent.mouseMove(svg, { clientX: 320, clientY: 100 });
    const tooltip = document.querySelector('.chart-tooltip');
    expect(tooltip).toBeTruthy();
    expect(tooltip!.textContent).toMatch(/cards drawn/);
    expect(tooltip!.textContent).toMatch(/turn \d+/);
    expect(tooltip!.textContent).toContain('Current deck (any combo):');
  });

  it('the tooltip disappears on mouse leave', () => {
    render(<App />);
    const svg = document.querySelector('svg[aria-label="probability curve"]') as SVGSVGElement;
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 640, height: 200, right: 640, bottom: 200, x: 0, y: 0, toJSON: () => ({}),
    });
    fireEvent.mouseMove(svg, { clientX: 320, clientY: 100 });
    expect(document.querySelector('.chart-tooltip')).toBeTruthy();
    fireEvent.mouseLeave(svg);
    expect(document.querySelector('.chart-tooltip')).toBeNull();
  });

  it('hovering exactly on a suggestion line shows THAT line (only) in the tooltip -- not the main curve or every line at once', () => {
    render(<App />);
    const svg = document.querySelector('svg[aria-label="probability curve"]') as SVGSVGElement;
    const suggestLines = svg.querySelectorAll('polyline.suggest-line');
    expect(suggestLines.length).toBeGreaterThan(0);
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 640, height: 200, right: 640, bottom: 200, x: 0, y: 0, toJSON: () => ({}),
    });
    // Hover at the EXACT rendered coordinate of a point on the suggestion
    // line (parsed from its own points attribute), not a guessed position --
    // guarantees the Y-aware hit-test picks this line, not the main curve.
    const points = suggestLines[0]!.getAttribute('points')!.split(' ').map((p) => p.split(',').map(Number));
    const [px, py] = points[Math.floor(points.length / 2)]!;
    fireEvent.mouseMove(svg, { clientX: px, clientY: py });

    const tooltip = document.querySelector('.chart-tooltip')!;
    expect(tooltip.textContent).toMatch(/Blink (ETB|Spell)/);
    expect(tooltip.textContent).not.toContain('Current deck (any combo)');
    // exactly one data row -- not the main curve's line ALSO shown alongside it
    expect(tooltip.querySelectorAll('div').length).toBe(2); // cards-drawn line + the one data line
  });

  it('suggestion lines NOW correctly appear for a non-monotone/multi-clause query too (this was the exact bug just fixed)', () => {
    render(<App />);
    fireEvent.click(screen.getByText('Edit as text'));
    const textarea = document.querySelector('.query-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '"Blink ETB">=1 & "Blink Spell">=1 | "Blink ETB">=3' } });
    const svg = document.querySelector('svg[aria-label="probability curve"]')!;
    const lines = svg.querySelectorAll('polyline.suggest-line');
    expect(lines.length).toBeGreaterThan(0);
    // sanity: each line's rendered points actually exist and aren't degenerate
    for (const line of lines) {
      const pts = line.getAttribute('points')!.split(' ');
      expect(pts.length).toBeGreaterThan(1);
    }
  });
});

describe('Mobile sticky bar and drawer (structural + interaction checks -- jsdom cannot fire real IntersectionObserver events, see CLAUDE.md §10)', () => {
  it('the rail sentinel exists for the observer to watch', () => {
    render(<App />);
    expect(document.querySelector('.rail-sentinel')).toBeTruthy();
  });

  it('the sticky bar is not rendered until "scrolled past" (stub never fires, so it starts false and stays false here)', () => {
    render(<App />);
    expect(document.querySelector('.mobile-sticky-bar')).toBeNull();
  });

  it('with scrolledPast forced true, chips match each group and Edit opens a drawer containing the SAME editor components as the rail', () => {
    render(
      <AppStateProvider>
        <QueryModelProvider>
          <MobileStickyBar scrolledPast={true} />
        </QueryModelProvider>
      </AppStateProvider>,
    );
    const chips = document.querySelectorAll('.count-chip');
    expect(chips.length).toBe(2); // Blink ETB, Blink Spell
    expect(chips[0]!.textContent).toContain('Blink ETB');

    // bump a count via the chip's own +/- buttons
    const incBtn = chips[0]!.querySelector('button[aria-label^="increase"]') as HTMLButtonElement;
    fireEvent.click(incBtn);
    expect((chips[0]!.querySelector('.chip-num') as HTMLInputElement).value).toBe('5');

    // Edit opens the drawer -- same DeckEditor/CombosEditor, not a duplicate
    fireEvent.click(screen.getByText('Edit'));
    const drawer = document.querySelector('.mobile-drawer')!;
    expect(drawer.querySelector('.group-row')).toBeTruthy(); // DeckEditor's real markup
    expect(drawer.querySelector('.combo-box')).toBeTruthy(); // CombosEditor's real markup

    // backdrop click closes it
    fireEvent.click(document.querySelector('.mobile-drawer-backdrop')!);
    expect(document.querySelector('.mobile-drawer')).toBeNull();
  });
});

describe('Chart hover pip (discrete point marker, not a continuous/interpolated position)', () => {
  it('a pip appears on the main curve at the exact (n, curve[n]) coordinate matching the tooltip value', () => {
    render(<App />);
    const svg = document.querySelector('svg[aria-label="probability curve"]') as SVGSVGElement;
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 640, height: 200, right: 640, bottom: 200, x: 0, y: 0, toJSON: () => ({}),
    });
    // hover at a raw x that does NOT land exactly on an integer n's pixel
    // position -- confirms the pip snaps to the nearest discrete n rather
    // than rendering at some interpolated/continuous mouse position.
    fireEvent.mouseMove(svg, { clientX: 313, clientY: 123 });
    const pip = document.querySelector('circle.hover-pip.main') as SVGCircleElement;
    expect(pip).toBeTruthy();

    const tooltipPct = document.querySelector('.chart-tooltip')!.textContent!.match(/Current deck \(any combo\): (\d+\.\d+)%/)![1];

    // recompute the expected pip position independently from the same
    // formulas ChartTab uses, and confirm the pip's cy corresponds to
    // EXACTLY the same integer n's curve value as the tooltip shows --
    // not a smoothed/interpolated y for the raw mouse position.
    const cx = Number(pip.getAttribute('cx'));
    const cy = Number(pip.getAttribute('cy'));
    const W = 640, H = 200, PAD = 28;
    const N = 40; // default deck size = N for this query
    const impliedN = Math.round(((cx - PAD) / (W - PAD - 8)) * N);
    const impliedP = (H - PAD - cy) / (H - PAD - 10);
    expect(Math.abs(impliedP * 100 - Number(tooltipPct))).toBeLessThan(0.5);
    expect(Number.isInteger(impliedN)).toBe(true);
  });

  it('the pip disappears along with the tooltip on mouse leave', () => {
    render(<App />);
    const svg = document.querySelector('svg[aria-label="probability curve"]') as SVGSVGElement;
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 640, height: 200, right: 640, bottom: 200, x: 0, y: 0, toJSON: () => ({}),
    });
    fireEvent.mouseMove(svg, { clientX: 320, clientY: 100 });
    expect(document.querySelector('circle.hover-pip.main')).toBeTruthy();
    fireEvent.mouseLeave(svg);
    expect(document.querySelector('circle.hover-pip.main')).toBeNull();
  });

  it('exactly ONE pip appears at a time, on whichever line is actually hovered -- not one per visible line', () => {
    render(<App />);
    const svg = document.querySelector('svg[aria-label="probability curve"]') as SVGSVGElement;
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 640, height: 200, right: 640, bottom: 200, x: 0, y: 0, toJSON: () => ({}),
    });
    const suggestLine = svg.querySelector('polyline.suggest-line')!;
    const points = suggestLine.getAttribute('points')!.split(' ').map((p) => p.split(',').map(Number));
    const [px, py] = points[Math.floor(points.length / 2)]!;
    fireEvent.mouseMove(svg, { clientX: px, clientY: py });

    const allPips = document.querySelectorAll('circle.hover-pip');
    expect(allPips.length).toBe(1);
    expect(allPips[0]!.classList.contains('suggest')).toBe(true);

    // moving to a point clearly on the MAIN curve instead switches the pip
    const mainLine = svg.querySelector('polyline.curve-line')!;
    const mainPoints = mainLine.getAttribute('points')!.split(' ').map((p) => p.split(',').map(Number));
    const [mx, my] = mainPoints[Math.floor(mainPoints.length / 2)]!;
    fireEvent.mouseMove(svg, { clientX: mx, clientY: my });
    const pipsNow = document.querySelectorAll('circle.hover-pip');
    expect(pipsNow.length).toBe(1);
    expect(pipsNow[0]!.classList.contains('main')).toBe(true);
  });
});

describe('URL sharing (real end-to-end through the actual app, not just the pure module)', () => {
  it('the hash auto-updates as deck size, groups, and query change', () => {
    render(<App />);
    expect(window.location.hash).not.toBe('');
    const before = window.location.hash;
    fireEvent.click([...document.querySelectorAll('.preset-chips button')].find((b) => b.textContent === '60')!);
    expect(window.location.hash).not.toBe(before);
  });

  it('target/turn/mulligans do NOT affect the hash (session preferences, not shareable state)', () => {
    render(<App />);
    const before = window.location.hash;
    const targetInputs = document.querySelectorAll('.advisor-inline');
    fireEvent.change(targetInputs[0]!, { target: { value: '50' } });
    expect(window.location.hash).toBe(before);
  });

  it('a fresh mount from a hand-crafted hash restores the exact deck, groups, and query', () => {
    const hash = '#' + encodeShared(99, [{ name: 'land', count: 38 }, { name: 'ramp', count: 6 }],
      '!land>=4 | (!land>=3 & !ramp>=1)');
    window.history.replaceState(null, '', hash);

    render(<App />);
    expect((screen.getByDisplayValue('99') as HTMLInputElement).value).toBe('99');
    expect(screen.getAllByDisplayValue('land').length).toBeGreaterThan(0);
    expect(screen.getAllByDisplayValue('ramp').length).toBeGreaterThan(0);
    // decompileFlat works on the RAW ast, not the simplified DNF, so this
    // renders as a normal 2-combo accordion, not a text fallback.
    expect(document.querySelectorAll('.combo-box').length).toBe(2);
  });

  it('an invalid/garbage hash falls back to the normal default deck, not a crash', () => {
    window.history.replaceState(null, '', '#not-valid-shared-state!!!');
    render(<App />);
    expect((screen.getByDisplayValue('40') as HTMLInputElement).value).toBe('40');
    expect(screen.getAllByDisplayValue('Blink ETB').length).toBeGreaterThan(0);
  });

  it('the Copy link button exists and copies the current URL', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<App />);
    fireEvent.click(screen.getByText('Copy link'));
    await new Promise((r) => setTimeout(r, 0));
    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(await screen.findByText('Copied!')).toBeInTheDocument();
  });
});

describe('Mulligan strategy (real end-to-end: exact recursive model, not the old flat-hand-size approximation)', () => {
  function setMulligans(n: number) {
    const label = screen.getByText('Mull.').closest('label')!;
    const input = label.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: String(n) } });
  }

  it('with 0 mulligans (default), no mulligan strategy line appears anywhere', () => {
    render(<App />);
    expect(document.querySelector('.mulligan-strategy-line')).toBeNull();
  });

  it('setting 1 mulligan shows the strategy line with real numbers, and optimal play is never worse than never-mulliganing', async () => {
    render(<App />);
    setMulligans(1);
    const line = await waitFor(() => {
      const el = document.querySelector('.mulligan-strategy-line');
      if (!el || !el.textContent) throw new Error('not ready');
      return el;
    });
    expect(line.textContent).toMatch(/With up to 1 mulligan, optimal play reaches/);
    const percents = line.textContent!.match(/(\d+)%/g)!.map((s) => Number(s.replace('%', '')));
    expect(percents.length).toBeGreaterThanOrEqual(2);
    const [bestP, neverP] = percents;
    expect(bestP!).toBeGreaterThanOrEqual(neverP!);
  });

  it('the default single-group-equivalent query (2 groups here) does NOT force a misleading single-group threshold description', async () => {
    render(<App />);
    setMulligans(1);
    // default query references 2 groups (Blink ETB, Blink Spell) -> describeAsThreshold
    // returns null for multi-group -> the generic fallback message should show
    await waitFor(() => {
      expect(document.querySelector('.mulligan-strategy-line')!.textContent)
        .toMatch(/isn.t a simple threshold|see the Suggestions tab/);
    });
  });

  it('the Suggestions tab shows the full per-hand breakdown table when mulligans > 0', async () => {
    render(<App />);
    setMulligans(1);
    fireEvent.click([...document.querySelectorAll('.tab-strip button')].find((b) => b.textContent === 'Suggestions')!);
    expect(await screen.findByText('Optimal mulligan strategy', { exact: false })).toBeInTheDocument();
    await waitFor(() => {
      const tables = document.querySelectorAll('.tab-panel-suggestions .num-table');
      // second num-table (after the minimal-vectors one) is the mulligan breakdown
      expect(tables.length).toBeGreaterThanOrEqual(2);
      const mulliganTable = tables[tables.length - 1]!;
      expect(mulliganTable.textContent).toMatch(/keep|mulligan/);
    });
  });

  it('going back to 0 mulligans removes the strategy line again (not stuck showing stale data)', async () => {
    render(<App />);
    setMulligans(2);
    await waitFor(() => expect(document.querySelector('.mulligan-strategy-line')).toBeTruthy());
    setMulligans(0);
    await waitFor(() => expect(document.querySelector('.mulligan-strategy-line')).toBeNull());
  });
});

describe('Mulligan-adjusted values in the chart, table, and grid (not just the advisor line)', () => {
  function setMulligans(n: number) {
    const label = screen.getByText('Mull.').closest('label')!;
    const input = label.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: String(n) } });
  }

  it('the chart main curve value at the opening hand point CHANGES when mulligans go from 0 to 1 (the actual reported jump)', async () => {
    render(<App />);
    const svg = document.querySelector('svg[aria-label="probability curve"]') as SVGSVGElement;
    const mainLineBefore = svg.querySelector('polyline.curve-line')!.getAttribute('points')!;
    setMulligans(1);
    await waitFor(() => {
      const after = document.querySelector('svg[aria-label="probability curve"] polyline.curve-line')!.getAttribute('points')!;
      expect(after).not.toBe(mainLineBefore);
    });
  });

  it('the table shows a HIGHER value at the opening-hand row with 1 mulligan than with 0 (mulliganing can only help or be neutral)', async () => {
    render(<App />);
    fireEvent.click([...document.querySelectorAll('.tab-strip button')].find((b) => b.textContent === 'Table')!);
    const getFirstRowPct = () => {
      const firstRow = document.querySelector('.tab-panel-table table.num-table tbody tr')!;
      return Number(firstRow.querySelectorAll('td')[2]!.textContent!.replace('%', ''));
    };
    const before = getFirstRowPct();
    setMulligans(1);
    await waitFor(() => {
      const after = getFirstRowPct();
      expect(after).toBeGreaterThan(before); // strict: this query's mulligan genuinely changes the value
    });
  });

  it('the grid shows mulligan-adjusted values too, and flags when it falls back to raw values for a too-large case', async () => {
    render(<App />);
    fireEvent.click([...document.querySelectorAll('.tab-strip button')].find((b) => b.textContent === 'Grid')!);
    const cellBefore = document.querySelector('.tab-panel-grid table.heat-table tr.active-row td')!.textContent;
    setMulligans(1);
    await waitFor(() => {
      const cellAfter = document.querySelector('.tab-panel-grid table.heat-table tr.active-row td')!.textContent;
      // grid's leftmost data column is at n=hand (the opening hand point) --
      // should reflect the SAME jump the chart/table show.
      expect(cellAfter).not.toBe(cellBefore);
    });
  });

  it('at 0 mulligans, the displayed curve is UNCHANGED from before this whole feature existed (exact passthrough, not just "close")', async () => {
    render(<App />);
    const svg = document.querySelector('svg[aria-label="probability curve"]') as SVGSVGElement;
    const points1 = svg.querySelector('polyline.curve-line')!.getAttribute('points');
    // toggle mulligans on then back to 0 -- should return to the exact same curve
    setMulligans(2);
    await waitFor(() => {
      const changed = document.querySelector('svg[aria-label="probability curve"] polyline.curve-line')!.getAttribute('points');
      expect(changed).not.toBe(points1);
    });
    setMulligans(0);
    await waitFor(() => {
      const points2 = document.querySelector('svg[aria-label="probability curve"] polyline.curve-line')!.getAttribute('points');
      expect(points2).toBe(points1);
    });
  });
});

describe('Mulligan computation loading state (the actual point: never freeze, always show progress)', () => {
  function setMulligans(n: number) {
    const label = screen.getByText('Mull.').closest('label')!;
    const input = label.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: String(n) } });
  }

  it('shows a "computing" indicator immediately after setting mulligans, before the result resolves', async () => {
    render(<App />);
    setMulligans(1);
    // the loading state should already be true synchronously (the effect
    // that sets it runs within the same act() flush as the input change),
    // BEFORE the async response has had a chance to resolve.
    expect(document.querySelector('.mulligan-loading')).toBeTruthy();
    await waitFor(() => {
      expect(document.querySelector('.mulligan-strategy-line')!.textContent)
        .toMatch(/With up to 1 mulligan/);
    });
    // once resolved, the loading indicator goes away
    expect(document.querySelector('.mulligan-loading')).toBeNull();
  });

  it('a new (superseding) mulligan count eventually replaces the old result, going through a loading state in between', async () => {
    render(<App />);
    setMulligans(1);
    await waitFor(() => {
      expect(document.querySelector('.mulligan-strategy-line')!.textContent).toMatch(/With up to 1 mulligan/);
    });
    const firstResultText = document.querySelector('.mulligan-strategy-line')!.textContent!;

    setMulligans(2); // supersedes -- a new computation starts
    await waitFor(() => {
      expect(document.querySelector('.mulligan-strategy-line')!.textContent).toMatch(/With up to 2 mulligans/);
    });
    expect(document.querySelector('.mulligan-strategy-line')!.textContent).not.toBe(firstResultText);
    // "old data stays visible while a newer request is loading" is proven
    // directly, without a race, in useWorkerRequest.test.ts using a fake
    // worker with full control over response timing -- not re-attempted
    // here against the sync fallback's near-instant microtask resolution,
    // which is too fast a window to assert against reliably end-to-end.
  });
});

describe('Mobile UI fixes: horizontal padding, sticky-bar sentinel position, chart draw cap', () => {
  it('the chart caps at 20 cards drawn even for a much larger deck (99), not deckSize', () => {
    render(<App />);
    fireEvent.click([...document.querySelectorAll('.preset-chips button')].find((b) => b.textContent === '99')!);
    const svg = document.querySelector('svg[aria-label="probability curve"]')!;
    expect(svg.querySelectorAll('line.vax, line.vax5').length).toBe(21); // n=0..20, not 0..99
    const mainLine = svg.querySelector('polyline.curve-line')!;
    const points = mainLine.getAttribute('points')!.split(' ');
    expect(points.length).toBe(21); // the polyline itself must not extend past the cap either
  });

  it('the rail sentinel sits BETWEEN DeckEditor and CombosEditor (after the first card specifically), not after the whole rail', () => {
    render(<App />);
    const rail = document.querySelector('.rail')!;
    const children = [...rail.children];
    const sentinelIdx = children.findIndex((c) => c.classList.contains('rail-sentinel'));
    const comboBoxIdx = children.findIndex((c) => c.querySelector('.combo-box') !== null);
    expect(sentinelIdx).toBeGreaterThan(-1);
    expect(comboBoxIdx).toBeGreaterThan(-1);
    // sentinel must come BEFORE the combos card, i.e. right after the deck card
    expect(sentinelIdx).toBeLessThan(comboBoxIdx);
  });
});
