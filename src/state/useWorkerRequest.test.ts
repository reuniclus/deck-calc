import { describe, it, expect } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useWorkerRequest, type WorkerLike } from './useWorkerRequest';

class FakeWorker implements WorkerLike {
  private listeners: Array<(e: MessageEvent) => void> = [];
  sentMessages: Array<{ id: number; [k: string]: unknown }> = [];
  postMessage(message: unknown): void {
    this.sentMessages.push(message as { id: number });
  }
  addEventListener(_type: 'message', listener: (e: MessageEvent) => void): void {
    this.listeners.push(listener);
  }
  removeEventListener(_type: 'message', listener: (e: MessageEvent) => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }
  /** Simulates the worker replying to a SPECIFIC request id, regardless of
   * send order -- lets tests deliberately resolve an OLDER request AFTER a
   * newer one to exercise the staleness-discard path. */
  respondTo(id: number, data: Record<string, unknown>): void {
    const event = { data: { id, ...data } } as MessageEvent;
    this.listeners.forEach((l) => l(event));
  }
}

describe('useWorkerRequest', () => {
  it('posts a request and resolves with the extracted result on a matching response', async () => {
    const worker = new FakeWorker();
    const { result } = renderHook(() =>
      useWorkerRequest<{ foo: string }, { id: number; ok: boolean; error?: string; value: number }>(worker, { foo: 'bar' }, (r) => r.value));

    expect(result.current.loading).toBe(true);
    expect(worker.sentMessages.length).toBe(1);
    const sentId = worker.sentMessages[0]!.id;

    act(() => { worker.respondTo(sentId, { ok: true, value: 42 }); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBe(42);
    expect(result.current.error).toBeNull();
  });

  it('a STALE response (from a superseded earlier request) is discarded, not applied', async () => {
    const worker = new FakeWorker();
    const { result, rerender } = renderHook(
      ({ req }: { req: { n: number } }) => useWorkerRequest<{ n: number }, { id: number; ok: boolean; error?: string; value: number }>(worker, req, (r) => r.value),
      { initialProps: { req: { n: 1 } } },
    );
    const firstId = worker.sentMessages[0]!.id;

    rerender({ req: { n: 2 } }); // supersedes the first request before it resolves
    const secondId = worker.sentMessages[1]!.id;
    expect(secondId).not.toBe(firstId);

    // the SECOND request resolves first (realistic: could arrive in any order)
    act(() => { worker.respondTo(secondId, { ok: true, value: 200 }); });
    await waitFor(() => expect(result.current.data).toBe(200));

    // the FIRST (now-stale) request's response arrives late -- must be ignored
    act(() => { worker.respondTo(firstId, { ok: true, value: 100 }); });
    expect(result.current.data).toBe(200); // unchanged, NOT overwritten by the stale 100
  });

  it('keeps the PREVIOUS data visible while a new request is loading, not blanked to null', async () => {
    const worker = new FakeWorker();
    const { result, rerender } = renderHook(
      ({ req }: { req: { n: number } }) => useWorkerRequest<{ n: number }, { id: number; ok: boolean; error?: string; value: number }>(worker, req, (r) => r.value),
      { initialProps: { req: { n: 1 } } },
    );
    act(() => { worker.respondTo(worker.sentMessages[0]!.id, { ok: true, value: 10 }); });
    await waitFor(() => expect(result.current.data).toBe(10));

    rerender({ req: { n: 2 } }); // triggers a new, slower request
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBe(10); // still showing the OLD value, not null
  });

  it('surfaces an error response, clearing data', async () => {
    const worker = new FakeWorker();
    const { result } = renderHook(() =>
      useWorkerRequest<{ foo: number }, { id: number; ok: boolean; error?: string; value: number }>(worker, { foo: 1 }, (r) => r.value));
    act(() => { worker.respondTo(worker.sentMessages[0]!.id, { ok: false, error: 'too large' }); });
    await waitFor(() => expect(result.current.error).toBe('too large'));
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('a null request (nothing to compute) clears state without posting anything', () => {
    const worker = new FakeWorker();
    const { result } = renderHook(() =>
      useWorkerRequest<{ id?: number }, { id: number; ok: true }>(worker, null, () => null));
    expect(worker.sentMessages.length).toBe(0);
    expect(result.current).toEqual({ data: null, loading: false, error: null });
  });

  it('a null worker (unavailable) also clears state without throwing', () => {
    const { result } = renderHook(() =>
      useWorkerRequest<{ id?: number }, { id: number; ok: true }>(null, { id: 1 }, () => null));
    expect(result.current).toEqual({ data: null, loading: false, error: null });
  });
});
