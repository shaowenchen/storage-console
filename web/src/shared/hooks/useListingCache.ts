import { useCallback, useMemo, useRef } from 'react';

const LISTING_CACHE_MS = 30000;
const LISTING_FAILURE_COOLDOWN_MS = 30000;

type CacheEntry<T> = {
  data: T;
  fetchedAt: number;
};

export function useListingCache<T>() {
  const cacheRef = useRef(new Map<string, CacheEntry<T>>());
  const inflightRef = useRef(new Map<string, Promise<T>>());
  const failedRef = useRef(new Map<string, number>());

  const get = useCallback((key: string): T | null => {
    const entry = cacheRef.current.get(key);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > LISTING_CACHE_MS) {
      cacheRef.current.delete(key);
      return null;
    }
    return entry.data;
  }, []);

  const set = useCallback((key: string, data: T) => {
    cacheRef.current.set(key, { data, fetchedAt: Date.now() });
  }, []);

  const invalidate = useCallback((matcher: (key: string) => boolean) => {
    for (const key of [...cacheRef.current.keys()]) {
      if (matcher(key)) cacheRef.current.delete(key);
    }
    for (const key of [...failedRef.current.keys()]) {
      if (matcher(key)) failedRef.current.delete(key);
    }
  }, []);

  const invalidateAll = useCallback(() => {
    cacheRef.current.clear();
    failedRef.current.clear();
  }, []);

  const fetchCached = useCallback(
    async (key: string, loader: () => Promise<T>, force = false): Promise<T> => {
      if (!force) {
        const cached = get(key);
        if (cached) return cached;
        const failedAt = failedRef.current.get(key);
        if (failedAt && Date.now() - failedAt < LISTING_FAILURE_COOLDOWN_MS) {
          throw new Error('Listing request failed recently. Use refresh to retry.');
        }
      } else {
        failedRef.current.delete(key);
      }
      if (inflightRef.current.has(key)) return inflightRef.current.get(key)!;
      const promise = loader()
        .then((data) => {
          set(key, data);
          failedRef.current.delete(key);
          return data;
        })
        .catch((err) => {
          failedRef.current.set(key, Date.now());
          throw err;
        })
        .finally(() => inflightRef.current.delete(key));
      inflightRef.current.set(key, promise);
      return promise;
    },
    [get, set],
  );

  return useMemo(
    () => ({ get, set, invalidate, invalidateAll, fetchCached }),
    [get, set, invalidate, invalidateAll, fetchCached],
  );
}
