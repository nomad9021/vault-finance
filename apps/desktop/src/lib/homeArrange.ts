import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { scrollParent } from "./dragSort.js";

/**
 * Home screen arranging, the iPhone way, for the phone and the computer alike.
 *
 * - Hold a card (about half a second, finger or mouse) and the home screen
 *   goes into edit mode with that card already picked up.
 * - In edit mode the whole card is the handle. A mouse drags as soon as it
 *   moves; a finger drags after a short hold, so a quick swipe still scrolls
 *   the page.
 * - While you drag, the other cards slide out of the way (FLIP animation) and
 *   the new order is saved when you let go.
 * - In edit mode, a focused card moves with the arrow keys.
 *
 * Elements inside a card marked `data-no-drag` (the hide badge, the size
 * pill) stay ordinary buttons.
 */
const HOLD_TO_EDIT_MS = 480;
const HOLD_TO_DRAG_TOUCH_MS = 160;
const MOUSE_SLOP = 4;
const TOUCH_SLOP = 8;

interface Live {
  id: string;
  pointerId: number;
  touch: boolean;
  x0: number;
  y0: number;
  x: number;
  y: number;
  started: boolean;
  timer: number | null;
  offX: number;
  offY: number;
  tx: number;
  ty: number;
  scroller: HTMLElement | null;
  /** Last card swapped with; ignored until the pointer moves onto another one. */
  lastSwap: string | null;
}

export function useHomeArrange({
  ids,
  editing,
  onStartEditing,
  onCommit,
}: {
  /** Current order of the cards on screen. */
  ids: string[];
  editing: boolean;
  onStartEditing: () => void;
  onCommit: (ids: string[]) => void;
}) {
  const [order, setOrder] = useState<string[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const els = useRef(new Map<string, HTMLElement>());
  const live = useRef<Live | null>(null);
  const prevRects = useRef<Map<string, DOMRect> | null>(null);
  const raf = useRef<number | null>(null);
  const opts = useRef({ ids, editing, onStartEditing, onCommit });
  opts.current = { ids, editing, onStartEditing, onCommit };
  const shown = order ?? ids;
  const shownRef = useRef(shown);
  shownRef.current = shown;

  /** Put the picked-up card under the finger, wherever the grid placed it. */
  const follow = useCallback(() => {
    const s = live.current;
    if (!s?.started) return;
    const el = els.current.get(s.id);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = r.left - s.tx;
    const top = r.top - s.ty;
    s.tx = s.x - s.offX - left;
    s.ty = s.y - s.offY - top;
    el.style.transform = `translate(${s.tx}px, ${s.ty}px) scale(1.03)`;
  }, []);

  // FLIP: cards that moved in the grid glide from where they were.
  useLayoutEffect(() => {
    const before = prevRects.current;
    prevRects.current = null;
    if (before) {
      for (const [id, el] of els.current) {
        if (id === live.current?.id) continue;
        const was = before.get(id);
        if (!was) continue;
        const now = el.getBoundingClientRect();
        const dx = was.left - now.left;
        const dy = was.top - now.top;
        if (!dx && !dy) continue;
        el.style.transition = "none";
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        void el.offsetWidth;
        el.style.transition = "transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)";
        el.style.transform = "";
      }
    }
    follow();
  }, [shown.join("|"), follow]); // eslint-disable-line react-hooks/exhaustive-deps

  const moveTo = useCallback((id: string, targetIndex: number) => {
    const cur = shownRef.current;
    const from = cur.indexOf(id);
    if (from < 0 || from === targetIndex) return false;
    const next = cur.filter((x) => x !== id);
    next.splice(targetIndex, 0, id);
    const rects = new Map<string, DOMRect>();
    for (const [k, el] of els.current) rects.set(k, el.getBoundingClientRect());
    prevRects.current = rects;
    setOrder(next);
    return true;
  }, []);

  const hit = useCallback(() => {
    const s = live.current;
    if (!s?.started) return;
    const under = (document.elementFromPoint(s.x, s.y) as HTMLElement | null)?.closest<HTMLElement>("[data-arrange-id]");
    const target = under?.dataset.arrangeId;
    if (!target || target === s.id) {
      if (!target) s.lastSwap = null;
      return;
    }
    if (target === s.lastSwap) return;
    const cur = shownRef.current;
    if (moveTo(s.id, cur.indexOf(target))) s.lastSwap = target;
  }, [moveTo]);

  const swallowNextClick = () => {
    const stopClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("click", stopClick, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener("click", stopClick, { capture: true }), 450);
  };

  const begin = useCallback(() => {
    const s = live.current;
    const el = s && els.current.get(s.id);
    if (!s || !el) return;
    const r = el.getBoundingClientRect();
    s.started = true;
    s.offX = s.x - r.left;
    s.offY = s.y - r.top;
    s.tx = 0;
    s.ty = 0;
    el.style.transition = "none";
    document.body.style.userSelect = "none";
    document.body.style.webkitUserSelect = "none";
    // No order snapshot here: holding to edit re-renders the edit-mode list
    // first, and the first swap works from whatever is on screen then.
    setDragId(s.id);
    // Scroll while held near the top or bottom edge.
    const tick = () => {
      const cur = live.current;
      if (!cur?.started) return;
      const sc = cur.scroller;
      const top = sc ? sc.getBoundingClientRect().top : 0;
      const bottom = sc ? sc.getBoundingClientRect().bottom : window.innerHeight;
      const edge = 80;
      const speed =
        cur.y < top + edge ? -Math.ceil((top + edge - cur.y) / 5) : cur.y > bottom - edge ? Math.ceil((cur.y - (bottom - edge)) / 5) : 0;
      if (speed) {
        if (sc) sc.scrollTop += speed;
        else window.scrollBy(0, speed);
        follow();
        hit();
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }, [follow, hit]);

  const end = useCallback(
    (commit: boolean) => {
      const s = live.current;
      live.current = null;
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = null;
      if (!s) return;
      if (s.timer) window.clearTimeout(s.timer);
      document.body.style.userSelect = "";
      document.body.style.webkitUserSelect = "";
      if (!s.started) return;
      swallowNextClick();
      // Settle the card into its slot.
      const el = els.current.get(s.id);
      if (el) {
        el.style.transition = "transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)";
        el.style.transform = "";
      }
      const final = shownRef.current;
      setDragId(null);
      if (commit && final.join("|") !== opts.current.ids.join("|")) {
        opts.current.onCommit(final);
      } else if (!commit) {
        const rects = new Map<string, DOMRect>();
        for (const [k, e] of els.current) rects.set(k, e.getBoundingClientRect());
        prevRects.current = rects;
      }
      setOrder(null);
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Window listeners for the life of one press.
  const listen = useCallback(() => {
    const move = (e: PointerEvent) => {
      const s = live.current;
      if (!s || e.pointerId !== s.pointerId) return;
      s.x = e.clientX;
      s.y = e.clientY;
      const moved = Math.hypot(s.x - s.x0, s.y - s.y0);
      if (!s.started) {
        if (opts.current.editing && !s.touch && moved > MOUSE_SLOP) begin();
        else if (moved > (s.touch ? TOUCH_SLOP : MOUSE_SLOP)) {
          // Moved before the hold finished: it's a scroll or a click-drag, not ours.
          cleanup();
          end(false);
          return;
        }
        if (!live.current?.started) return;
      }
      e.preventDefault();
      follow();
      hit();
    };
    // A finger that's dragging a card mustn't scroll the page (iOS honours this).
    const touchMove = (e: TouchEvent) => {
      if (live.current?.started) e.preventDefault();
    };
    const up = (e: PointerEvent) => {
      if (live.current && e.pointerId !== live.current.pointerId) return;
      cleanup();
      end(true);
    };
    const cancel = () => {
      cleanup();
      end(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("touchmove", touchMove);
      window.removeEventListener("keydown", key);
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("touchmove", touchMove, { passive: false });
    window.addEventListener("keydown", key);
  }, [begin, end, follow, hit]);

  useEffect(() => () => end(false), [end]);

  const onPointerDown = (id: string, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || live.current) return;
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    const touch = e.pointerType !== "mouse";
    const el = els.current.get(id);
    live.current = {
      id,
      pointerId: e.pointerId,
      touch,
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
      started: false,
      timer: null,
      offX: 0,
      offY: 0,
      tx: 0,
      ty: 0,
      scroller: scrollParent(el ?? null),
      lastSwap: null,
    };
    if (!opts.current.editing) {
      // Hold to edit: picks the card up straight away, like the iPhone.
      live.current.timer = window.setTimeout(() => {
        if (!live.current || live.current.started) return;
        opts.current.onStartEditing();
        begin();
      }, HOLD_TO_EDIT_MS);
    } else if (touch) {
      live.current.timer = window.setTimeout(() => {
        if (live.current && !live.current.started) begin();
      }, HOLD_TO_DRAG_TOUCH_MS);
    } else {
      // Mouse in edit mode: no text selection while it might become a drag.
      e.preventDefault();
    }
    listen();
  };

  /** Arrow keys move a focused card one place (edit mode). */
  const onKeyDown = (id: string, e: ReactKeyboardEvent<HTMLElement>) => {
    if (!opts.current.editing || e.target !== e.currentTarget) return;
    const step = e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : 0;
    if (!step) return;
    e.preventDefault();
    const cur = shownRef.current;
    const at = cur.indexOf(id);
    const to = at + step;
    if (to < 0 || to >= cur.length) return;
    const next = cur.filter((x) => x !== id);
    next.splice(to, 0, id);
    opts.current.onCommit(next);
    requestAnimationFrame(() => els.current.get(id)?.focus());
  };

  /** Spread on each card. */
  const bind = (id: string, index: number) => {
    const dragging = dragId === id;
    return {
      ref: (el: HTMLElement | null) => {
        if (el) els.current.set(id, el);
        else els.current.delete(id);
      },
      "data-arrange-id": id,
      ...(dragging ? { "data-dragging": "true" as const } : {}),
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => onPointerDown(id, e),
      onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => onKeyDown(id, e),
      onContextMenu: (e: ReactMouseEvent<HTMLElement>) => {
        // A long-press menu would fight the hold-to-edit gesture.
        if (live.current || opts.current.editing) e.preventDefault();
      },
      style: { ["--jiggle-delay" as string]: `${(index % 4) * -0.09}s` } as CSSProperties,
    };
  };

  return { order: shown, dragId, bind };
}
