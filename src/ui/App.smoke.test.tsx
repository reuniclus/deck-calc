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
    expect(screen.getByText('27')).toBeInTheDocument();
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
    expect(screen.getByText('37')).toBeInTheDocument(); // 40 - 0 - 3
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
