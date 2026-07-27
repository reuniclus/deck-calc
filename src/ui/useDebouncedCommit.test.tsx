import { describe, it, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { useState } from 'react';
import { useDebouncedCommit } from './useDebouncedCommit';

describe('useDebouncedCommit', () => {
  it('updates the local (displayed) value immediately, before the debounce delay elapses', () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    let localRef = 0;
    let onChangeRef: (v: number) => void = () => {};
    function Harness() {
      const [value] = useState(0);
      const [local, onChange] = useDebouncedCommit(value, commit, 300);
      localRef = local;
      onChangeRef = onChange;
      return null;
    }
    render(<Harness />);
    expect(localRef).toBe(0);
    act(() => { onChangeRef(55); });
    expect(localRef).toBe(55); // local updates instantly, well before the 300ms commit delay
    expect(commit).not.toHaveBeenCalled(); // but the expensive commit hasn't fired yet
    vi.useRealTimers();
  });

  it('does NOT commit before the delay elapses', () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    let onChangeRef: (v: number) => void = () => {};
    function Harness() {
      const [value] = useState(0);
      const [, onChange] = useDebouncedCommit(value, commit, 300);
      onChangeRef = onChange;
      return null;
    }
    render(<Harness />);
    act(() => { onChangeRef(42); });
    expect(commit).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(299); });
    expect(commit).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(2); });
    expect(commit).toHaveBeenCalledWith(42);
    expect(commit).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('rapid changes commit ONCE with the LAST value, not once per change (debounce, not throttle)', () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    let onChangeRef: (v: number) => void = () => {};
    function Harness() {
      const [value] = useState(0);
      const [, onChange] = useDebouncedCommit(value, commit, 300);
      onChangeRef = onChange;
      return null;
    }
    render(<Harness />);
    act(() => {
      onChangeRef(9);
      vi.advanceTimersByTime(100);
      onChangeRef(90); // typing "9" then "90" -- each resets the timer
      vi.advanceTimersByTime(100);
      onChangeRef(9); // then backspacing to "9" again
    });
    expect(commit).not.toHaveBeenCalled(); // still within the debounce window
    act(() => { vi.advanceTimersByTime(300); });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(9); // the LAST value, not the first or a stale one
    vi.useRealTimers();
  });

  it('unmounting before the delay elapses does not commit (cleanup clears the timer)', () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    let onChangeRef: (v: number) => void = () => {};
    function Harness() {
      const [value] = useState(0);
      const [, onChange] = useDebouncedCommit(value, commit, 300);
      onChangeRef = onChange;
      return null;
    }
    const { unmount } = render(<Harness />);
    act(() => { onChangeRef(7); });
    unmount();
    act(() => { vi.advanceTimersByTime(500); });
    expect(commit).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
