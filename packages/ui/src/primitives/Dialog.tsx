import type { ReactNode } from "react";
import { useEffect } from "react";
import { createPortal } from "react-dom";

export interface DialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  /** Rendered in the actions row, right-aligned. */
  actions?: ReactNode;
  onClose: () => void;
}

export function Dialog({ open, title, children, actions, onClose }: DialogProps) {
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
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-title">{title}</div>
        <div className="dialog-body">{children}</div>
        {actions && <div className="dialog-actions">{actions}</div>}
      </div>
    </div>,
    document.body,
  );
}
