import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AppStateProvider, useAppDispatch } from './AppState';
import { QueryModelProvider, useQueryModelCtx } from './useQueryModel';

function useHarness() {
  const dispatch = useAppDispatch();
  const model = useQueryModelCtx();
  return { dispatch, model };
}

describe('QueryModelProvider: target changes must not re-run the expensive base pipeline', () => {
  it('result (the DP output) stays REFERENCE-STABLE across a target change; only analysis is a new object', () => {
    const { result } = renderHook(() => useHarness(), {
      wrapper: ({ children }) => (
        <AppStateProvider><QueryModelProvider>{children}</QueryModelProvider></AppStateProvider>
      ),
    });
    const resultBefore = result.current.model.result;
    const analysisBefore = result.current.model.analysis;
    expect(resultBefore).not.toBeNull();

    act(() => { result.current.dispatch({ type: 'setTarget', target: 0.5 }); });

    const resultAfter = result.current.model.result;
    const analysisAfter = result.current.model.analysis;
    // The DP output itself (curve, clauses, terms, monotone) must be the SAME
    // object reference -- proves evaluate()/normalize()/parseQuery were NOT
    // re-run just because target changed.
    expect(resultAfter).toBe(resultBefore);
    // analyze() DOES need to re-run (it reads target), so this one legitimately changes.
    expect(analysisAfter).not.toBe(analysisBefore);
    expect(analysisAfter!.target).toBe(0.5);
  });

  it('result DOES get recomputed (new reference) when the query text actually changes', () => {
    const { result } = renderHook(() => useHarness(), {
      wrapper: ({ children }) => (
        <AppStateProvider><QueryModelProvider>{children}</QueryModelProvider></AppStateProvider>
      ),
    });
    const resultBefore = result.current.model.result;
    act(() => { result.current.dispatch({ type: 'setQuery', query: '"Blink ETB">=2' }); });
    expect(result.current.model.result).not.toBe(resultBefore);
  });
});
