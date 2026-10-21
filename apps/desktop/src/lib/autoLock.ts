import { useEffect } from "react";
import { useApp } from "../state/store.js";

/**
 * Locks the signed-in app when the person steps away: the computer slept or
 * the lid closed (the app's clock jumps), they've been idle for the chosen
 * minutes, the OS screen locked (platform.onSystemLock), or they pressed
 * Ctrl/Cmd+L. Closing the app needs nothing here — it quits, and always
 * starts locked.
 */

/** A tick this much later than expected means the computer was asleep. */
export const SLEEP_GAP_MS = 30_000;
const TICK_MS = 5_000;

/** Screens that count as activity while open (the review presenter auto-advances). */
let keepAwake = 0;
export function useKeepUnlocked() {
  useEffect(() => {
    keepAwake++;
    return () => {
      keepAwake--;
    };
  }, []);
}

/** Pure decision for one tick, so it can be unit tested. */
export function shouldLock(now: number, lastTick: number, lastActivity: number, autoLockMinutes: number): "sleep" | "idle" | null {
  if (now - lastTick > TICK_MS + SLEEP_GAP_MS) return "sleep";
  if (autoLockMinutes > 0 && now - lastActivity >= autoLockMinutes * 60_000) return "idle";
  return null;
}

export function useAutoLock(active: boolean) {
  const platform = useApp((s) => s.platform);
  const lock = useApp((s) => s.lock);
  const minutes = useApp((s) => s.autoLockMinutes);

  useEffect(() => {
    if (!active) return;
    let lastTick = Date.now();
    let lastActivity = Date.now();
    const touch = () => (lastActivity = Date.now());
    const events = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true });

    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        lock();
      }
    };
    window.addEventListener("keydown", onKey);

    const timer = setInterval(() => {
      const now = Date.now();
      if (keepAwake > 0) lastActivity = now;
      const why = shouldLock(now, lastTick, lastActivity, minutes);
      lastTick = now;
      if (why) lock();
    }, TICK_MS);

    const stopSystem = platform.onSystemLock?.(() => lock());

    return () => {
      for (const e of events) window.removeEventListener(e, touch);
      window.removeEventListener("keydown", onKey);
      clearInterval(timer);
      stopSystem?.();
    };
  }, [active, platform, lock, minutes]);
}
