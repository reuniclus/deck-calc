import { useEffect, useRef, useState } from 'react';

/**
 * Local state updates immediately on every change (so the input itself
 * never feels laggy); the actual commit -- which is what triggers the
 * expensive downstream recompute (the suggestion search, at up to ~300ms
 * for the general path) -- only fires after `delayMs` of no further
 * changes. Typing "90" as two keystrokes commits once, not twice.
 */
export function useDebouncedCommit<T>(
  value: T,
  commit: (v: T) => void,
  delayMs = 300,
): [T, (v: T) => void] {
  const [local, setLocal] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Stay in sync if the value changes for a reason OTHER than our own debounce
  // (e.g. a shared URL loaded a different state) -- harmless no-op the rest
  // of the time, since committing our own change also updates `value` right
  // back to what `local` already is.
  useEffect(() => { setLocal(value); }, [value]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  function onChange(v: T): void {
    setLocal(v);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => commit(v), delayMs);
  }

  return [local, onChange];
}
