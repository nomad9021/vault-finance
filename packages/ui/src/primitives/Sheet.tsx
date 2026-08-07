import type { ReactNode } from "react";
import { useEffect } from "react";

export interface SheetProps {
  open: boolean;
  title?: string;
  children: ReactNode;
  onClose: () => void;
}

/**
 * Bottom sheet — the phone-native modal, reused at narrow desktop widths so a
 * resized window keeps behaving like the device it now resembles.
 */
export function Sheet({ open, title, children, onClose }: SheetProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // Stop the page behind from scrolling under the sheet.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-grip" aria-hidden="true" />
        {title && <div className="panel-title" style={{ marginBottom: "var(--space-3)" }}>{title}</div>}
        {children}
      </div>
    </>
  );
}
