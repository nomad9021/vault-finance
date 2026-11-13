import { useEffect, useRef, useState } from "react";

/** The count-up never runs longer than the app's motion ceiling. */
const DURATION_MS = 300;

/** Close to the app's curve, cubic-bezier(0.22, 1, 0.36, 1): fast, soft landing. */
const easeOut = (t: number) => 1 - Math.pow(1 - t, 4);

/**
 * A figure that counts up to its value when it first appears and glides to a
 * new value when it changes, in 300ms. Reduced Motion shows the value at once.
 */
export function useCountUp(target: number): number {
  const [shown, setShown] = useState(target);
  const from = useRef(0);
  const shownRef = useRef(0);

  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce || !Number.isFinite(target)) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    from.current = shownRef.current;
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION_MS);
      const v = from.current + (target - from.current) * easeOut(t);
      shownRef.current = v;
      setShown(v);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  return shown;
}
