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
10. **jsdom does NOT load Vite's CSS imports or run real layout.** `getComputedStyle` in tests reflects only inline styles and jsdom's minimal UA defaults — it will NOT tell you whether a stylesheet rule applies, let alone whether something visually overflows. Tests for CSS-driven behavior can only confirm the right elements/classes exist for the stylesheet to target (structural), never that the rendered result is actually correct (pixel-level). Wasted a round writing tests that asserted computed style from `index.css` rules before catching this — don't repeat it.
9. Every new math function gets a test against either the BigInt oracle or brute-force enumeration before it gets a UI.

## Style

- `strict` TS, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Assume they're on and write accordingly.
- Comments explain *why*, not *what*. Non-obvious math gets a citation to the relevant `PLAN.md` section.
- No default exports except React route/page components.
