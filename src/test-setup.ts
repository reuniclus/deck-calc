import '@testing-library/jest-dom/vitest';
import { beforeEach } from 'vitest';

/**
 * window.location.hash persists across test cases within the same jsdom run
 * unless explicitly reset. AppState now auto-syncs the hash on every render
 * (URL sharing, see hashState.ts) -- without this reset, one test's leftover
 * hash silently changes the NEXT test's starting deck/query via
 * computeInitialState(), which is exactly what happened the first time this
 * was wired in: 27 unrelated tests failed because an earlier test's hash
 * state leaked forward. Confirmed as the actual cause before adding this,
 * not assumed.
 */
beforeEach(() => {
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
});

/**
 * jsdom provides NO IntersectionObserver at all (confirmed directly: `new
 * JSDOM(...).window.IntersectionObserver` is `undefined`, not a stub that
 * behaves oddly). Without this, any component using it throws immediately on
 * mount in tests. This stub only prevents that crash -- it never actually
 * fires a callback, so any behavior gated on a real intersection change
 * (e.g. MobileNav's "scrolled past the rail" detection) cannot be genuinely
 * exercised here. That's the same class of gap as CLAUDE.md's jsdom-has-no-
 * real-layout note: tests can confirm the right elements/classes exist for
 * the behavior to attach to, never that the behavior itself fires correctly
 * against real viewport geometry.
 */
class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// @ts-expect-error -- test-only global stub, not a spec-accurate implementation
globalThis.IntersectionObserver = IntersectionObserverStub;
