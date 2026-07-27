# CLAUDE.md

Working agreements for this repo. Read this and `CODEMAP.md` before touching code; `PLAN.md` holds the architecture and algorithms.

## Commands

| task | command |
|---|---|
| dev server | `npm run dev` |
| production build | `npm run build` |
| preview the build | `npm run preview` |
| tests (once) | `npm test` |
| tests (watch) | `npm run test:watch` |
| typecheck | `npm run typecheck` |
| build the single-file math harness | `npm run harness` → `dist-harness/harness.html` |
| build + verify the harness in jsdom | `npm run harness:smoke` |

`npm run build` runs `tsc -b` first, so a type error fails the build.

## Toolchain (actual installed versions)

React 19 · TypeScript 7 · Vite 8 · Vitest 4 · Node 22

`PLAN.md` was written against React 18; the API surface used here is unchanged.

## Hard rules

1. **`src/math/**` is pure.** No React, no DOM, no imports from outside `src/math`. It has to stay portable into a Web Worker and directly testable.
2. **`src/math/exact.ts` is test-only.** BigInt oracle. Never import it from app code.
3. **Groups are disjoint.** The multivariate hypergeometric requires a partition of the deck. Violating this produces wrong numbers with no error. Enforce in the model, assert in the DP.
4. **`others` is derived, never stored.** `others = deckSize - Σ group counts`.
5. **Never clamp numeric inputs while the user is typing.** Hold input as a string in local state, commit on valid parse. Invalid deck states are allowed and shown, not silently corrected.
6. **Queries reference groups by stable `id`, never by name or array index.** The AST is the source of truth; display text is regenerated via `printExpr` with current names. Renaming a group must not change any result; deleting a referenced group must surface an explicit error, never silently different numbers.
7. **`vite.config.ts` `base` must match the repo name** (`/deck-calc/`) or the Pages build serves a blank page.
8. **The harness is generated, never hand-edited.** `src/harness/` is the source; the single-file HTML is a build artifact. It imports the real `src/math` modules so it cannot drift from tested code.
9. **The real UI (`src/ui/`, `src/state/`) needs a real render test, not just `tsc`.** Typecheck passing does not mean the wiring works — this session alone, a real React Testing Library render caught two bugs (an unparseable seed query; a rename that silently broke the query instead of re-deriving it) that `tsc -b` and `vite build` both missed. Every new interactive piece gets at least one test that actually renders it and fires the events a user would.
10. **jsdom does NOT load Vite's CSS imports, run real layout, or implement `IntersectionObserver`.** `getComputedStyle` in tests reflects only inline styles and jsdom's minimal UA defaults — it will NOT tell you whether a stylesheet rule applies, let alone whether something visually overflows. `IntersectionObserver` is `undefined` entirely (confirmed directly) — `src/test-setup.ts` stubs it just to stop components from crashing on mount; the stub never fires a callback, so anything gated on a real intersection change (e.g. `MobileNav`'s "scrolled past the rail" detection) cannot be genuinely exercised in tests. Tests for CSS- or viewport-driven behavior can only confirm the right elements/classes exist for the behavior to attach to (structural), never that the behavior itself fires correctly (pixel/geometry-level). Wasted a round writing tests that asserted computed style from `index.css` rules before catching this — don't repeat it.
11. **`window.location` (including `.hash`) persists across test cases within the same jsdom run.** Any feature that reads or writes it (e.g. `AppState`'s URL-hash sharing) needs an explicit reset between tests, or one test's leftover hash silently changes the NEXT test's starting state. Confirmed directly: wiring in hash-sync without a reset broke 27 unrelated tests in one run, because each `render(<App/>)` picked up whatever hash the previous test had left behind. `src/test-setup.ts` resets it in a global `beforeEach` — don't remove that thinking it's dead code.
12. **UI scale is 1.5x via `zoom` on `html` (src/index.css), not a rewrite of the ~73 hardcoded px values to rem.** Chosen deliberately over `transform: scale()`: `zoom` recalculates actual layout at the scaled size (containers/scrollbars adjust correctly) and keeps `getBoundingClientRect()`/`clientX` reported in the SAME scaled coordinate space as the rest of the page — so `App.tsx`'s pointer-drag rail-resize math and `ResultView.tsx`'s chart-hover math needed zero changes. Verified with real Playwright screenshots (a Chromium install exists at `/opt/pw-browsers/`, `playwright` installs via `npm install --no-save playwright` -- npmjs.org domains are allow-listed): at the identical 900px viewport, unscaled shows the desktop two-column layout while zoomed shows the mobile single-column layout, confirming the mobile breakpoint and rail bounds correctly operate in the same effective-CSS-pixel space that zoom scales.
13. **jsdom has no `Worker` at all (confirmed directly, same class of gap as `IntersectionObserver`).** Every test involving `mulliganWorkerClient.ts` exercises ONLY the synchronous fallback path (`SyncFallbackMulliganWorker`) -- the real `Worker` code (`mulliganWorker.ts`, the actual point of that whole module) has zero test coverage in this suite and cannot get any without a real browser. Verified separately, once, with a real headless Chromium + Playwright (not committed as a test, since it needs a real browser this project doesn't have in CI): confirmed the worker script is genuinely requested over the network (not silently falling back to sync), the result is correct, and -- the actual point -- `requestAnimationFrame` kept firing at a steady rate with zero stalls for the full ~2.7s duration of a real 2-mulligan computation, where the old synchronous version would have frozen the page solid for that whole window. If this class of feature needs touching again, re-verify the same way rather than trusting jsdom's green checkmarks alone.
9. Every new math function gets a test against either the BigInt oracle or brute-force enumeration before it gets a UI.

## Style

- `strict` TS, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Assume they're on and write accordingly.
- Comments explain *why*, not *what*. Non-obvious math gets a citation to the relevant `PLAN.md` section.
- No default exports except React route/page components.
