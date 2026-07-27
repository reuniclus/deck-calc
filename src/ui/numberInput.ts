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
