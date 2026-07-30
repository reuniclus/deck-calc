/**
 * CSS `zoom` (see index.css's `html { zoom: 1.5 }`) scales rendered CSS
 * length values -- a `left: Npx` renders at N*zoom actual screen pixels.
 * `event.clientX`/`clientY`, however, are already reported in final,
 * POST-zoom viewport pixels (confirmed directly: mouse at real screen
 * position 684.5 produced clientX=684.5, not 684.5/1.5). Using clientX
 * directly as a CSS length (e.g. a `position: fixed` element's `left`)
 * therefore applies the zoom TWICE -- once implicitly (clientX is already
 * zoomed) and once explicitly (the browser zooms the CSS length again on
 * render) -- producing an offset that grows with distance from the origin.
 * Dividing by this factor before use cancels the second application;
 * confirmed directly to land exactly on the real cursor position, not
 * just approximately.
 *
 * Shared by App.tsx's rail-drag math and ResultView.tsx's chart tooltip --
 * both need the exact same correction, so it lives in one place rather
 * than two copies that could drift apart.
 */
export function zoomFactor(): number {
  if (typeof getComputedStyle === 'undefined') return 1;
  const parsed = Number.parseFloat(getComputedStyle(document.documentElement).zoom);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Pure, testable core of "correct a clientX/clientY pair for use as a
 * position:fixed left/top" -- separated from the DOM-reading zoomFactor()
 * so this specific arithmetic can be tested directly in jsdom (which
 * doesn't apply real CSS zoom, so testing the DOM-reading wrapper itself
 * wouldn't exercise anything meaningful). Same pattern as
 * computeRailWidthFromDrag in App.tsx, which needed the identical fix once
 * already for a different clientX-as-CSS-length case.
 */
export function unzoomedPosition(clientX: number, clientY: number, zoom: number): { left: number; top: number } {
  const safeZoom = zoom > 0 ? zoom : 1;
  return { left: clientX / safeZoom, top: clientY / safeZoom };
}
