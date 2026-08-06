import { useState } from 'react';

/**
 * Parses a number-input's raw string, treating an emptied field as 0 rather
 * than silently ignoring the change. The naive `if (Number.isFinite(v))
 * dispatch(...)` guard leaves a CONTROLLED input visually stuck blank on
 * backspace-to-empty: React only touches the DOM when the bound value
 * actually differs from the previous render, and since nothing was
 * dispatched, the value prop never changes, so the browser's own emptied
 * display just sits there. Every numeric field in this app clamps to its
 * own valid minimum inside its reducer branch already, so dispatching 0
 * unconditionally is always safe.
 */
export function parseNumOr0(raw: string): number {
  const v = parseInt(raw, 10);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Lets a numeric field be VISUALLY EMPTY while being typed into, without the value
 * jumping to a clamped minimum mid-edit.
 *
 * The problem with dispatching `parseNumOr0` on every keystroke: emptying a deck-size
 * field sends 0, the reducer clamps it to 1, and the field redisplays "1" -- so
 * backspace-then-type-99 produces "199". The field fights the user.
 *
 * `parseNumOr0` exists because a CONTROLLED input goes stuck-blank if nothing is
 * dispatched (React only touches the DOM when the bound value changes, and it didn't).
 * Holding the in-progress text in LOCAL state removes that constraint entirely: the
 * input is bound to the local string, so it can legitimately be empty, and the parent
 * only hears about parseable values.
 *
 * On blur an empty or unparseable field snaps back to the last committed value rather
 * than to a minimum, so abandoning an edit restores what was there instead of
 * silently rewriting it.
 */
export function useNumberField(
  value: number,
  commit: (n: number) => void,
): { value: string; onChange: (raw: string) => void; onBlur: () => void } {
  const [text, setText] = useState<string | null>(null);
  return {
    value: text ?? String(value),
    onChange: (raw: string) => {
      setText(raw);
      const v = parseInt(raw, 10);
      if (Number.isFinite(v)) commit(v);
    },
    onBlur: () => setText(null),
  };
}
