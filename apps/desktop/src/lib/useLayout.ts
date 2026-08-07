import { useEffect, useState } from "react";

/**
 * How much room the window has, expressed as the three shapes the shell knows
 * how to be. These thresholds match the breakpoints in components.css — if you
 * change one, change the other.
 *
 *   wide   ≥1200  full labelled sidebar
 *   medium  900   icon rail with tooltips
 *   narrow  <900  bottom tab bar, group pages as a top tab strip
 */
export type LayoutMode = "wide" | "medium" | "narrow";

function read(): LayoutMode {
  if (typeof window === "undefined") return "wide";
  const w = window.innerWidth;
  if (w < 900) return "narrow";
  if (w < 1200) return "medium";
  return "wide";
}

export function useLayoutMode(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(read);

  useEffect(() => {
    // Two queries cover all three modes and only fire on an actual crossing,
    // which is much cheaper than listening to every resize event.
    const narrow = window.matchMedia("(max-width: 899.98px)");
    const medium = window.matchMedia("(max-width: 1199.98px)");
    const update = () => setMode(read());
    narrow.addEventListener("change", update);
    medium.addEventListener("change", update);
    return () => {
      narrow.removeEventListener("change", update);
      medium.removeEventListener("change", update);
    };
  }, []);

  return mode;
}
