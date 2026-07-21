import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Tiny fetch-into-state hook: no cache, no dedupe — pages are small and the
 * server is on the LAN. `reload()` refetches after mutations.
 */
export function useData<T>(fetcher: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);

  const load = useCallback(() => {
    const gen = ++generation.current;
    setLoading(true);
    return fetcher()
      .then((result) => {
        if (gen === generation.current) {
          setData(result);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (gen === generation.current) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      })
      .finally(() => {
        if (gen === generation.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, loading, reload: load };
}
