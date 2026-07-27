import { useEffect, useRef, useState } from 'react';
import { AppStateProvider } from '../state/AppState';
import { QueryModelProvider } from '../state/useQueryModel';
import { SuggestionsProvider } from '../state/useSuggestions';
import { DeckEditor } from './DeckEditor';
import { CombosEditor } from './CombosEditor';
import { ResultView, type ResultTab } from './ResultView';
import { AdvisorStrip } from './AdvisorStrip';
import { MobileStickyBar, useScrolledPastRail } from './MobileNav';
import { CopyLinkButton } from './CopyLinkButton';

const RAIL_MIN = 180, RAIL_MAX = 450, RAIL_DEFAULT = 230;

/**
 * `clientX`/`getBoundingClientRect()` report REAL, already-zoomed pixels
 * (html has `zoom: 1.5` -- see index.css). But the result of this
 * computation gets stored into `railWidth` state and fed straight back into
 * `gridTemplateColumns: ${railWidth}px`, a CSS value that lives INSIDE that
 * same zoomed ancestor -- so the browser would apply the zoom to it AGAIN,
 * compounding it. Divide out the zoom factor first, or dragging to a real
 * on-screen position of e.g. 300px renders the rail at 450px: 1.5x further
 * than the mouse actually is. This was a real, reported bug (not caught by
 * the earlier screenshot verification, which only checked static layout,
 * never a pointer-driven CSS-value feedback loop like this one).
 */
export function computeRailWidthFromDrag(clientX: number, gridLeft: number, zoomFactor: number): number {
  const safeZoom = zoomFactor > 0 ? zoomFactor : 1;
  const unzoomed = (clientX - gridLeft) / safeZoom;
  return Math.max(RAIL_MIN, Math.min(RAIL_MAX, unzoomed));
}

function currentZoomFactor(): number {
  if (typeof getComputedStyle === 'undefined') return 1;
  const parsed = Number.parseFloat(getComputedStyle(document.documentElement).zoom);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/** Rail width is a "how I like to look at it" view preference, not shared or
 * exported state (see UI_DESIGN.md) -- localStorage, deliberately outside
 * AppState/the reducer. Desktop only; there is no rail to drag on mobile. */
function useRailWidth(): [number, (w: number) => void] {
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('deckcalc.railWidth'));
    return saved >= RAIL_MIN && saved <= RAIL_MAX ? saved : RAIL_DEFAULT;
  });
  useEffect(() => { localStorage.setItem('deckcalc.railWidth', String(width)); }, [width]);
  return [width, setWidth];
}

function Layout() {
  const [railWidth, setRailWidth] = useRailWidth();
  const [tab, setTab] = useState<ResultTab>('chart');
  const [sentinelRef, scrolledPastRail] = useScrolledPastRail();
  const gridRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    function onMove(e: PointerEvent): void {
      if (!dragging.current || !gridRef.current) return;
      const rect = gridRef.current.getBoundingClientRect();
      setRailWidth(computeRailWidthFromDrag(e.clientX, rect.left, currentZoomFactor()));
    }
    function onUp(): void { dragging.current = false; }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [setRailWidth]);

  return (
    <>
      <MobileStickyBar scrolledPast={scrolledPastRail} />
      <div className="app-grid" ref={gridRef} style={{ gridTemplateColumns: `${railWidth}px 8px 1fr` }}>
        <div className="rail">
          <CopyLinkButton />
          <DeckEditor />
          <CombosEditor />
          {/* Sits at the bottom of the RAIL's own content specifically, not
              after the whole page -- on mobile the rail stacks above main
              (this is exactly the boundary "scrolled past setup" should mean);
              on desktop it's side-by-side so this rarely matters, but the
              sticky bar stays CSS-hidden above the mobile breakpoint anyway. */}
          <div ref={sentinelRef} className="rail-sentinel" aria-hidden="true" />
        </div>
        <div
          className="resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the setup and combos rail"
          onPointerDown={() => { dragging.current = true; }}
        />
        <div className="main">
          <AdvisorStrip onSeeSuggestions={() => setTab('suggestions')} />
          <ResultView tab={tab} setTab={setTab} />
        </div>
      </div>
    </>
  );
}

export function App() {
  return (
    <AppStateProvider>
      <QueryModelProvider>
        <SuggestionsProvider>
          <main>
            <h1>deck-calc</h1>
            <Layout />
          </main>
        </SuggestionsProvider>
      </QueryModelProvider>
    </AppStateProvider>
  );
}
