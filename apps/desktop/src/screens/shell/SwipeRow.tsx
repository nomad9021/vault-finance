import { useRef, useState, type PointerEvent, type ReactNode } from "react";

export interface SwipeAction {
  label: string;
  tone?: "neutral" | "danger";
  onAction: () => void;
}

const ACTION_W = 80; // px per action button

/**
 * A list row with iPhone-style swipe actions: swipe left to reveal buttons
 * on the right (like Mail), swipe back or tap the row to close. Vertical
 * scrolling stays native (touch-action: pan-y); a gesture only counts as a
 * swipe once it's clearly sideways. Mouse users get the same actions
 * through the row's own tap (the edit dialog), so nothing is swipe-only.
 */
export function SwipeRow({
  actions,
  children,
  label,
}: {
  actions: SwipeAction[];
  children: ReactNode;
  /** Names the row for the actions' screen-reader labels. */
  label: string;
}) {
  const width = actions.length * ACTION_W;
  const [x, setX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const g = useRef<{ x0: number; y0: number; base: number; axis: "x" | "y" | null } | null>(null);
  const moved = useRef(false);

  const onDown = (e: PointerEvent) => {
    if (e.pointerType === "mouse") return;
    g.current = { x0: e.clientX, y0: e.clientY, base: x, axis: null };
    moved.current = false;
  };
  const onMove = (e: PointerEvent) => {
    const s = g.current;
    if (!s) return;
    const dx = e.clientX - s.x0;
    const dy = e.clientY - s.y0;
    if (!s.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      s.axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? "x" : "y";
      if (s.axis === "x") {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        setDragging(true);
      }
    }
    if (s.axis !== "x") return;
    moved.current = true;
    // Resistance past fully open; no swiping right past closed.
    const next = s.base + dx;
    setX(next < -width ? -width + (next + width) * 0.25 : Math.min(0, next));
  };
  const onUp = () => {
    const s = g.current;
    g.current = null;
    setDragging(false);
    if (!s || s.axis !== "x") return;
    setX((cur) => (cur < -width / 2 ? -width : 0));
  };

  return (
    <div className="swipe-row">
      <div className="swipe-actions" style={{ width }} aria-hidden={x === 0}>
        {actions.map((a) => (
          <button
            key={a.label}
            type="button"
            tabIndex={x === 0 ? -1 : 0}
            className={a.tone === "danger" ? "swipe-action is-danger" : "swipe-action"}
            aria-label={`${a.label} ${label}`}
            onClick={() => {
              setX(0);
              a.onAction();
            }}
          >
            {a.label}
          </button>
        ))}
      </div>
      <div
        className="swipe-front"
        style={{ transform: x ? `translateX(${x}px)` : undefined, transition: dragging ? "none" : undefined }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onClickCapture={(e) => {
          // A swipe isn't a tap, and tapping an open row just closes it.
          if (moved.current || x !== 0) {
            e.stopPropagation();
            e.preventDefault();
            moved.current = false;
            setX(0);
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
