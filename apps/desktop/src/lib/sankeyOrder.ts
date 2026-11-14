import { useEffect, useState } from "react";
import { useApp } from "../state/store.js";

/**
 * The person's own arrangement of the Sankey bars, saved to their account and
 * shared by every diagram (Home, Budget vs actual, Planner), so dragging a
 * category in one moves it in all of them.
 */
let cache: string[] | undefined;
let loading: Promise<void> | null = null;
const listeners = new Set<(o: string[] | undefined) => void>();

export function useSankeyOrder(): [string[] | undefined, (next: string[]) => void] {
  const client = useApp((s) => s.client);
  const [order, setOrder] = useState(cache);
  useEffect(() => {
    listeners.add(setOrder);
    if (cache === undefined && !loading) {
      loading = client
        .preferences()
        .then((p) => {
          cache = p.sankeyOrder ?? [];
          for (const l of listeners) l(cache);
        })
        .catch(() => {})
        .finally(() => {
          loading = null;
        });
    }
    return () => {
      listeners.delete(setOrder);
    };
  }, [client]);
  const save = (next: string[]) => {
    cache = next;
    for (const l of listeners) l(next);
    void client.savePreferences({ sankeyOrder: next }).catch(() => {});
  };
  return [order, save];
}
