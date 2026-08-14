import type { ReactNode } from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon.js";

export interface DateFieldProps {
  label: string;
  /** "YYYY-MM-DD", or "" for no date. */
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  error?: string | undefined;
  /** Shown in the trigger when there's no date yet. */
  placeholder?: string;
  /** Offer a "Clear" action inside the picker. */
  clearable?: boolean;
  /** Bounds, "YYYY-MM-DD". Days outside are shown but not selectable. */
  min?: string;
  max?: string;
  disabled?: boolean;
}

/**
 * A date field that owns its own calendar.
 *
 * `<input type="date">` was the obvious choice and the wrong one: the popup it
 * opens belongs to the browser engine, not to us. It ignores our themes (the
 * calendar renders light on a dark app), and how it dismisses differs per
 * engine — on the Tauri build's WebKitGTK you could click a date and stay stuck
 * in the control. Neither is fixable from CSS, because none of that popup is in
 * our document.
 *
 * So the calendar below is ours: our tokens, our dismissal rules, identical on
 * every engine. The trigger keeps the `.input` class so it still reads as one of
 * the form fields around it.
 *
 * The popover is portalled to the body and positioned fixed, because dialogs
 * scroll (`.dialog { overflow: auto }`) and an absolutely-positioned popover
 * would be clipped by them.
 */
export function DateField({
  label,
  value,
  onChange,
  hint,
  error,
  placeholder = "Pick a date",
  clearable = true,
  min,
  max,
  disabled = false,
}: DateFieldProps) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // Which month the grid is showing — not the same as the selected day, since
  // you can page through months without picking anything.
  const [cursor, setCursor] = useState(() => monthOf(value));
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const close = useCallback((focusTrigger = true) => {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  // Re-sync the visible month whenever the value changes from outside (a reset,
  // or a different row opening in the same dialog).
  useEffect(() => {
    if (!open) setCursor(monthOf(value));
  }, [value, open]);

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.max(r.width, 268);
    const height = popRef.current?.offsetHeight ?? 320;
    // Flip above when there isn't room below, and keep it on screen either way.
    const below = window.innerHeight - r.bottom;
    const top = below < height + 12 && r.top > height + 12 ? r.top - height - 6 : r.bottom + 6;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
    setPos({ top, left, width });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    // Dialogs and pages scroll under the popover; follow the trigger rather
    // than leaving the calendar floating somewhere it no longer belongs.
    const onMove = () => place();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      // Clicking away commits nothing and closes — and crucially does not let
      // the click fall through to a dialog backdrop that would close the form.
      e.preventDefault();
      e.stopPropagation();
      close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Swallow it, or the surrounding Dialog closes too and the edit is lost.
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, close]);

  const selected = parseISO(value);
  const pick = (iso: string) => {
    onChange(iso);
    close();
  };

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <button
        id={id}
        ref={triggerRef}
        type="button"
        className="input datefield-trigger"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-invalid={error ? true : undefined}
        onClick={() => {
          setCursor(monthOf(value));
          setOpen((v) => !v);
        }}
      >
        <span className={value ? undefined : "datefield-placeholder"}>
          {value ? longDate(value) : placeholder}
        </span>
        <Icon name="calendar" size={16} />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            className="datefield-pop elev-lg"
            role="dialog"
            aria-label={`Choose ${label}`}
            style={{ top: pos.top, left: pos.left, width: pos.width }}
          >
            <div className="datefield-head">
              <button
                type="button"
                className="datefield-nav"
                aria-label="Previous month"
                onClick={() => setCursor(shiftMonth(cursor, -1))}
              >
                <Icon name="chevronLeft" size={16} />
              </button>
              <div className="datefield-month">{monthTitle(cursor)}</div>
              <button
                type="button"
                className="datefield-nav"
                aria-label="Next month"
                onClick={() => setCursor(shiftMonth(cursor, 1))}
              >
                <Icon name="chevronRight" size={16} />
              </button>
            </div>

            <div className="datefield-grid" role="grid">
              {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
                <div key={`${d}${i}`} className="datefield-dow" aria-hidden="true">
                  {d}
                </div>
              ))}
              {daysFor(cursor).map((cell, i) =>
                cell === null ? (
                  <span key={`pad${i}`} />
                ) : (
                  <button
                    key={cell.iso}
                    type="button"
                    className="datefield-day"
                    disabled={outOfRange(cell.iso, min, max)}
                    aria-current={cell.iso === todayISO() ? "date" : undefined}
                    {...(selected && cell.iso === value ? { "data-selected": "true" } : {})}
                    {...(cell.iso === todayISO() ? { "data-today": "true" } : {})}
                    onClick={() => pick(cell.iso)}
                  >
                    {cell.day}
                  </button>
                ),
              )}
            </div>

            <div className="datefield-foot">
              <button type="button" className="datefield-action" onClick={() => pick(todayISO())}>
                Today
              </button>
              {clearable && (
                <button
                  type="button"
                  className="datefield-action"
                  onClick={() => {
                    onChange("");
                    close();
                  }}
                >
                  Clear
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}

      {error ? (
        <div role="alert" className="field-error">
          {error}
        </div>
      ) : hint ? (
        <div className="field-hint">{hint}</div>
      ) : null}
    </div>
  );
}

// ── date helpers ────────────────────────────────────────────────────────────
// Everything is UTC. The app stores plain YYYY-MM-DD calendar dates with no
// time, and going through local time would shift them a day either side of
// midnight depending on the viewer's offset.
//
// Exported for tests: the grid maths (Monday-first alignment, month lengths,
// leap years) is exactly the kind of thing that looks right until February.

export function parseISO(iso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(t) ? null : new Date(t);
}

export function toISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** First of the month a value sits in, falling back to the current month. */
export function monthOf(iso: string): Date {
  const d = parseISO(iso) ?? new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function shiftMonth(d: Date, delta: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1));
}

function monthTitle(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

function longDate(iso: string): string {
  const d = parseISO(iso);
  if (!d) return iso;
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function outOfRange(iso: string, min?: string, max?: string): boolean {
  if (min && iso < min) return true;
  if (max && iso > max) return true;
  return false;
}

/** Monday-first cells for a month, with leading blanks for alignment. */
export function daysFor(cursor: Date): ({ iso: string; day: number } | null)[] {
  const year = cursor.getUTCFullYear();
  const month = cursor.getUTCMonth();
  const total = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const lead = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7;
  const cells: ({ iso: string; day: number } | null)[] = Array.from({ length: lead }, () => null);
  for (let day = 1; day <= total; day++) {
    cells.push({ iso: toISO(new Date(Date.UTC(year, month, day))), day });
  }
  return cells;
}
