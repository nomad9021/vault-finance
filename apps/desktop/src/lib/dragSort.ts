import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";

/**
 * Drag and drop for arranging things — home screen cards, Sankey categories —
 * on pointer events, so it works the same with a mouse, a trackpad and a
 * finger (HTML5 drag and drop doesn't fire on iPhone). Grab a handle, move,
 * let go over another item: the page decides what before/after/inside means.
 *
 * Items mark themselves with `data-drop-id`; the dragged one follows the
 * pointer and stops catching it, so the item underneath is the target. The
 * nearest scrolling container scrolls when the pointer nears its edge.
 */
export type DropZone = "before" | "after" | "inside";

export interface DragState {
  id: string;
  dx: number;
  dy: number;
}

export function useDragSort({
  onDrop,
  zoneFor = (rect, x, y) => (rect.width > rect.height * 2.5 ? (y < rect.top + rect.height / 2 ? "before" : "after") : x < rect.left + rect.width / 2 ? "before" : "after"),
  canDrop = () => true,
}: {
  onDrop: (dragId: string, targetId: string, zone: DropZone) => void;
  /** Which part of the target the pointer is over. Default: halves, along the long side. */
  zoneFor?: (rect: DOMRect, x: number, y: number, targetId: string) => DropZone;
  canDrop?: (dragId: string, targetId: string, zone: DropZone) => boolean;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [over, setOver] = useState<{ id: string; zone: DropZone } | null>(null);
  const live = useRef<{ id: string; x0: number; y0: number; scroller: HTMLElement | null; x: number; y: number; over: { id: string; zone: DropZone } | null } | null>(null);
  const opts = useRef({ onDrop, zoneFor, canDrop });
  opts.current = { onDrop, zoneFor, canDrop };
  const raf = useRef<number | null>(null);

  const stop = useCallback((commit: boolean) => {
    const s = live.current;
    live.current = null;
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = null;
    setDrag(null);
    setOver(null);
    document.body.style.userSelect = "";
    if (commit && s?.over) opts.current.onDrop(s.id, s.over.id, s.over.zone);
  }, []);

  useEffect(() => {
    if (!drag) return;
    const hit = (x: number, y: number) => {
      const s = live.current;
      if (!s) return;
      const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>("[data-drop-id]");
      const id = el?.dataset.dropId;
      let next: { id: string; zone: DropZone } | null = null;
      if (el && id && id !== s.id) {
        const zone = opts.current.zoneFor(el.getBoundingClientRect(), x, y, id);
        if (opts.current.canDrop(s.id, id, zone)) next = { id, zone };
      }
      s.over = next;
      setOver((prev) => (prev?.id === next?.id && prev?.zone === next?.zone ? prev : next));
    };
    // Scroll while held near the top or bottom edge.
    const tick = () => {
      const s = live.current;
      if (!s) return;
      const sc = s.scroller;
      const top = sc ? sc.getBoundingClientRect().top : 0;
      const bottom = sc ? sc.getBoundingClientRect().bottom : window.innerHeight;
      const edge = 70;
      const speed = s.y < top + edge ? -Math.ceil((top + edge - s.y) / 6) : s.y > bottom - edge ? Math.ceil((s.y - (bottom - edge)) / 6) : 0;
      if (speed) {
        if (sc) sc.scrollTop += speed;
        else window.scrollBy(0, speed);
        s.y0 -= speed;
        setDrag((d) => (d ? { ...d, dy: s.y - s.y0 } : d));
        hit(s.x, s.y);
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    const move = (e: PointerEvent) => {
      const s = live.current;
      if (!s) return;
      e.preventDefault();
      s.x = e.clientX;
      s.y = e.clientY;
      setDrag({ id: s.id, dx: e.clientX - s.x0, dy: e.clientY - s.y0 });
      hit(e.clientX, e.clientY);
    };
    const up = () => stop(true);
    const cancel = () => stop(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && stop(false);
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
    };
  }, [drag?.id, stop]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Spread on the grab handle. */
  const handle = (id: string) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      live.current = { id, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, scroller: scrollParent(e.currentTarget), over: null };
      document.body.style.userSelect = "none";
      setDrag({ id, dx: 0, dy: 0 });
    },
    style: { touchAction: "none", cursor: drag?.id === id ? "grabbing" : "grab" } as CSSProperties,
  });

  /** Spread on each item: marks it as a drop target and moves it while dragged. */
  const item = (id: string): { "data-drop-id": string; "data-dragging"?: "true"; "data-drop"?: DropZone; style: CSSProperties } => {
    const dragging = drag?.id === id;
    return {
      "data-drop-id": id,
      ...(dragging ? { "data-dragging": "true" as const } : {}),
      ...(over?.id === id ? { "data-drop": over.zone } : {}),
      style: dragging
        ? { transform: `translate(${drag.dx}px, ${drag.dy}px)`, pointerEvents: "none", zIndex: 50, position: "relative", boxShadow: "var(--shadow-lg)", opacity: 0.92 }
        : {},
    };
  };

  return { drag, over, handle, item };
}

export function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let cur = el?.parentElement ?? null; cur; cur = cur.parentElement) {
    const oy = getComputedStyle(cur).overflowY;
    if ((oy === "auto" || oy === "scroll") && cur.scrollHeight > cur.clientHeight) return cur;
  }
  return null;
}

/** Move `id` to before/after `targetId` in a flat list of ids. */
export function reorder(ids: string[], id: string, targetId: string, zone: "before" | "after"): string[] {
  if (id === targetId) return ids;
  const rest = ids.filter((x) => x !== id);
  const at = rest.indexOf(targetId);
  if (at < 0) return ids;
  rest.splice(zone === "before" ? at : at + 1, 0, id);
  return rest;
}
