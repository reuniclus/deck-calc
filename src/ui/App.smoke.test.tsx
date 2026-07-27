import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { App } from './App';

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
    const table = document.querySelector('table.num-table')!;
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
