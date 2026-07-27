/**
 * Generic async-request hook for talking to a Worker-like object. "Worker-
 * like" deliberately, not `Worker` itself: only needs postMessage +
 * addEventListener('message')/removeEventListener('message') -- lets this
 * be tested with a plain fake object, since jsdom has no real Worker at
 * all (confirmed directly). The actual app wires a real Worker in
 * production and falls back to a synchronous same-shape "worker" when
 * Worker is unavailable (see useMulliganStrategy.tsx) -- this hook doesn't
 * know or care which.
 *
 * A NEW request supersedes any in-flight one: if the request changes again
 * before a response arrives, the earlier response is discarded when it
 * eventually shows up (matched by request id) rather than overwriting
 * newer data with a stale answer.
 *
 * Deliberately keeps the PREVIOUS data visible while loading a new
 * request, rather than blanking the UI to null -- a freezing computation
 * is exactly the failure mode being fixed here; replacing real numbers
 * with "no data yet" for a few seconds would just trade one bad UX for
 * another.
 */
import { useEffect, useRef, useState } from 'react';

export interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
}

interface IdentifiedResponse {
  id: number;
  ok: boolean;
  error?: string;
}

export interface WorkerRequestState<TResult> {
  data: TResult | null;
  loading: boolean;
  error: string | null;
}

let nextRequestId = 1;

export function useWorkerRequest<TRequest, TResponse extends IdentifiedResponse>(
  worker: WorkerLike | null,
  request: TRequest | null,
  extractResult: (response: TResponse) => unknown,
): WorkerRequestState<unknown> {
  const [state, setState] = useState<WorkerRequestState<unknown>>({ data: null, loading: false, error: null });
  const latestIdRef = useRef(0);
  // Compare by VALUE, not object reference. A caller passing a fresh object
  // literal each render (easy mistake -- exactly what this hook's own test
  // did) would otherwise re-trigger the effect every render: new object ->
  // effect runs -> postMessage + setState -> re-render -> new object again
  // -> infinite loop. Confirmed directly: an earlier version of this hook
  // OOM-crashed the test runner this way. JSON.stringify cost here is
  // negligible next to the computation being requested.
  const fingerprint = request === null ? null : JSON.stringify(request);

  useEffect(() => {
    if (!worker || !request) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    const id = ++nextRequestId;
    latestIdRef.current = id;
    setState((s) => ({ ...s, loading: true, error: null })); // keep s.data -- see doc comment

    function onMessage(e: MessageEvent<TResponse>): void {
      if (e.data.id !== latestIdRef.current) return; // superseded by a newer request; discard
      if (e.data.ok) setState({ data: extractResult(e.data), loading: false, error: null });
      else setState({ data: null, loading: false, error: e.data.error ?? 'unknown error' });
    }
    worker.addEventListener('message', onMessage);
    worker.postMessage({ ...request, id });
    return () => worker.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worker, fingerprint]);

  return state;
}
