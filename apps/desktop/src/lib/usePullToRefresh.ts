import { useEffect, useRef, useState, type RefObject } from "react";

/** Pull this far (px, after resistance) and let go to refresh. */
export const PULL_TRIGGER = 64;
const MAX_PULL = 96;

/**
 * iPhone-style pull to refresh on a scroll container: when it's scrolled to
 * the top, dragging down pulls the page with resistance, and letting go past
 * the trigger calls `onRefresh`. Touch only; mouse and trackpad are unchanged.
 * Returns how far the page is pulled and whether a refresh is showing.
 */
export function usePullToRefresh(
  scroller: RefObject<HTMLElement | null>,
  onRefresh: () => Promise<void> | void,
  enabled: boolean,
): { pull: number; refreshing: boolean } {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef<number | null>(null);
  const pullRef = useRef(0);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  useEffect(() => {
    const el = scroller.current;
    if (!el || !enabled) return;
    const set = (v: number) => {
      pullRef.current = v;
      setPull(v);
    };
    const onStart = (e: TouchEvent) => {
      startY.current = el.scrollTop <= 0 && e.touches.length === 1 ? e.touches[0]!.clientY : null;
    };
    const onMove = (e: TouchEvent) => {
      if (startY.current === null) return;
      const dy = e.touches[0]!.clientY - startY.current;
      if (dy <= 0 || el.scrollTop > 0) {
        if (pullRef.current) set(0);
        return;
      }
      e.preventDefault(); // our pull instead of the rubber-band bounce
      set(Math.min(MAX_PULL, dy * 0.5));
    };
    const onEnd = () => {
      if (startY.current === null) return;
      startY.current = null;
      if (pullRef.current >= PULL_TRIGGER) {
        setRefreshing(true);
        set(PULL_TRIGGER * 0.75);
        Promise.resolve(refreshRef.current())
          // Long enough to read as "refreshed" even when the data is instant.
          .then(() => new Promise((r) => setTimeout(r, 600)))
          .finally(() => {
            setRefreshing(false);
            set(0);
          });
      } else {
        set(0);
      }
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [scroller, enabled]);

  return { pull, refreshing };
}
