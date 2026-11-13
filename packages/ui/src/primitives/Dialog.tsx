import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface DialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  /** Rendered in the actions row, right-aligned. */
  actions?: ReactNode;
  onClose: () => void;
}

/** How far a sheet must be dragged down (px) before letting go closes it. */
const DISMISS_PX = 96;

export function Dialog({ open, title, children, actions, onClose }: DialogProps) {
  // Phone: the dialog is a bottom sheet (components.css) that can be dragged
  // down by its grabber or title to dismiss, like an iOS sheet.
  const [drag, setDrag] = useState(0);
  const start = useRef<{ y: number; t: number } | null>(null);
  const onDown = (e: ReactPointerEvent) => {
    if (!window.matchMedia("(max-width: 640px)").matches) return;
    start.current = { y: e.clientY, t: performance.now() };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent) => {
    if (start.current) setDrag(Math.max(0, e.clientY - start.current.y));
  };
  const onUp = (e: ReactPointerEvent) => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    const dy = e.clientY - s.y;
    const fast = dy / Math.max(1, performance.now() - s.t) > 0.6; // a quick flick
    setDrag(0);
    if (dy > DISMISS_PX || (fast && dy > 24)) onClose();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  // Rendered on <body>, not where it's declared: an ancestor with a transform
  // (every .page keeps its fadeUp animation's end state) becomes the
  // containing block for position: fixed in WebKit, which sized the backdrop
  // to the whole page and centred the dialog off-screen on long pages.
  return createPortal(
    <div
      className="dialog-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={drag ? { transform: `translateY(${drag}px)`, transition: "none" } : undefined}
      >
        <div
          className="dialog-drag"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          <div className="dialog-grabber" aria-hidden="true" />
          <div className="dialog-title">{title}</div>
        </div>
        <div className="dialog-body">{children}</div>
        {actions && <div className="dialog-actions">{actions}</div>}
      </div>
    </div>,
    document.body,
  );
}
