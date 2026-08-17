// useCachedResource — one shared "fetch on mount into a nullable state" hook
// (BET-1057). It replaces the five hand-rolled fetch pairs in Settings
// (subscriptions, endpoints, models, plugins, forge rules), each of which hid
// a real loading state. The cache is a process-lifetime module-level Map: it
// survives Settings closing and reopening, so the second open renders
// instantly from the cache while a background revalidation refreshes it.
// There is deliberately no expiry, no TTL and no persistence to disk — a plain
// Map IS the whole design.
//
// FETCHER IDENTITY IS CAPTURED, NOT A REACT DEPENDENCY. The initial mount
// fetch and every `refresh()` read the LATEST fetcher through a ref, so a
// change in the fetcher's identity never re-triggers the fetch — the hook
// keys off `key` only. Callers should still keep the fetcher stable (e.g.
// wrap it in `useCallback`) and only change it when the resource itself
// changes (a different `key`), not to force a refetch. To force a refetch,
// call `refresh()`; to knock a resource out of the cache so the NEXT mount
// cold-starts again, call `invalidateCachedResource(key)`.

import { useCallback, useEffect, useRef, useState } from "react";

const cache = new Map<string, unknown>();

export function useCachedResource<T>(
  key: string,
  fetcher: () => Promise<T>,
): {
  data: T | null;
  /** True ONLY on a cold start (no cached value yet). A background
   *  revalidation never flips this, so a poll can't flicker the UI. */
  loading: boolean;
  error: string | null;
  /** Force a refetch and update the cache. Never flips `loading`. */
  refresh: () => Promise<void>;
  /** Run a mutation that writes to this resource, routing a failure into the
   *  SAME `error` this hook already exposes — so the card needs no second
   *  error state and no extra JSX. Never throws and never flips `loading`.
   *
   *  On success `error` is cleared. On a throw the message lands in `error`
   *  and NOTHING ELSE RUNS — which is why every call site puts its own
   *  `refresh()` INSIDE `fn`: a refresh after a failed mutation would call
   *  `load()`, whose success path clears `error`, wiping the message that was
   *  just set. (A failed mutation changed nothing on the box, so there is
   *  nothing to refetch anyway.)
   *
   *  An API that reports failure as a RESULT rather than a rejection (e.g.
   *  `{ ok: false, error }`) must be turned into a `throw` inside `fn`. */
  mutate: (fn: () => Promise<void>) => Promise<void>;
} {
  const [data, setData] = useState<T | null>(() =>
    cache.has(key) ? (cache.get(key) as T) : null,
  );
  // loading starts true exactly when nothing is cached yet — a warm cache
  // renders immediately and a cold start shows the loader.
  const [loading, setLoading] = useState<boolean>(() => !cache.has(key));
  const [error, setError] = useState<string | null>(null);
  // Suppresses state updates after unmount (the cancelled-flag pattern the
  // effects this replaces already used).
  const cancelledRef = useRef(false);
  // Latest fetcher wins regardless of identity — see the header comment.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // Shared fetch: writes the cache + data on success, sets error on
  // rejection WITHOUT clearing cached data (a stale-but-real list beats an
  // empty one). Only a cold-start fetch clears `loading`.
  const load = useCallback(
    async (coldStart: boolean) => {
      try {
        const value = await fetcherRef.current();
        if (cancelledRef.current) return;
        cache.set(key, value);
        setData(value);
        setError(null);
      } catch (e) {
        if (cancelledRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelledRef.current && coldStart) setLoading(false);
      }
    },
    [key],
  );

  useEffect(() => {
    cancelledRef.current = false;
    const coldStart = !cache.has(key);
    void load(coldStart);
    return () => {
      cancelledRef.current = true;
    };
  }, [key, load]);

  const refresh = useCallback(async () => {
    await load(false);
  }, [load]);

  const mutate = useCallback(async (fn: () => Promise<void>) => {
    try {
      await fn();
      if (!cancelledRef.current) setError(null);
    } catch (e) {
      if (!cancelledRef.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  return { data, loading, error, refresh, mutate };
}

export function invalidateCachedResource(key: string): void {
  cache.delete(key);
}
