import { useEffect, useRef, useState } from 'react';
import { useAppDispatch, useAppState } from '../state/AppState';
import { colorFor } from './DeckEditor';
import { NumberInput } from './NumberInput';
import { DeckEditor } from './DeckEditor';
import { CombosEditor } from './CombosEditor';

/**
 * Watches a sentinel placed right after the rail; once it scrolls out of
 * view (past, not just not-yet-reached -- a single sentinel right after the
 * rail correctly distinguishes both directions), the sticky bar takes over.
 * Mobile only (desktop's rail is always visible, so there's nothing to
 * detect). jsdom has no IntersectionObserver at all (confirmed directly,
 * not assumed) -- see CLAUDE.md for the test-environment stub and its limits.
 */
function useScrolledPastRail(): [React.RefObject<HTMLDivElement | null>, boolean] {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [scrolledPast, setScrolledPast] = useState(false);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver(([entry]) => setScrolledPast(!entry!.isIntersecting), { threshold: 0 });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return [sentinelRef, scrolledPast];
}

function CountChip({ groupId, name, count }: { groupId: string; name: string; count: number }) {
  const dispatch = useAppDispatch();
  const set = (n: number) => dispatch({ type: 'setGroupCount', id: groupId, count: Math.max(0, n) });
  return (
    <div className="count-chip">
      <span className="dot" style={{ background: colorFor(groupId) }} />
      <span className="chip-name">{name}</span>
      <button aria-label={`decrease ${name}`} onClick={() => set(count - 1)}>&minus;</button>
      <NumberInput
        className="chip-num"
        type="number"
        min={0}
        value={count}
        onCommit={set}
      />
      <button aria-label={`increase ${name}`} onClick={() => set(count + 1)}>+</button>
    </div>
  );
}

/**
 * Sentinel lives right after the rail in normal scroll flow (rendered by the
 * caller); this component is the sticky bar + drawer pair that appear once
 * scrolled past it. The rail's REAL content (DeckEditor/CombosEditor) is
 * never duplicated -- the drawer renders the same components, not a second
 * copy of the logic, so there is exactly one source of truth for "what's
 * editable here" regardless of which surface you reach it from.
 */
export function MobileStickyBar({ scrolledPast }: { scrolledPast: boolean }) {
  const { groups } = useAppState();
  const [drawerOpen, setDrawerOpen] = useState(false);

  if (!scrolledPast) return null;

  return (
    <>
      <div className="mobile-sticky-bar">
        <div className="chip-row">
          {groups.map((g) => <CountChip key={g.id} groupId={g.id} name={g.name} count={g.count} />)}
        </div>
        <button className="edit-btn" onClick={() => setDrawerOpen(true)}>Edit</button>
      </div>
      {drawerOpen && (
        <div className="mobile-drawer-backdrop" onClick={() => setDrawerOpen(false)}>
          <div className="mobile-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-header">
              <span className="section-label" style={{ margin: 0 }}>Deck &amp; combos</span>
              <button className="icon-btn" aria-label="Close" onClick={() => setDrawerOpen(false)}>&#10005;</button>
            </div>
            <DeckEditor />
            <CombosEditor />
          </div>
        </div>
      )}
    </>
  );
}

export { useScrolledPastRail };
