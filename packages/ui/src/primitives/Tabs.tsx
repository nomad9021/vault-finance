import type { ReactNode } from "react";
import { useRef } from "react";

export interface TabItem<T extends string> {
  value: T;
  label: string;
  /** Optional count/badge shown after the label. */
  badge?: ReactNode;
}

export interface TabsProps<T extends string> {
  items: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange: (value: T) => void;
  "aria-label"?: string;
}

/**
 * In-page tabs. These carry the consolidated pages — Budgets holds its
 * planner, Cash Flow holds the debt plan — so related tools live one click
 * apart instead of being separate destinations in the sidebar.
 *
 * Arrow keys move between tabs, per the WAI-ARIA tabs pattern.
 */
export function Tabs<T extends string>({ items, value, onChange, ...aria }: TabsProps<T>) {
  const ref = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const i = items.findIndex((t) => t.value === value);
    const next = items[(i + dir + items.length) % items.length];
    if (next) {
      onChange(next.value);
      // Move focus with selection so the keyboard user sees where they are.
      ref.current?.querySelectorAll<HTMLButtonElement>(".tab")[
        items.indexOf(next)
      ]?.focus();
    }
  };

  return (
    <div className="tabs" role="tablist" aria-label={aria["aria-label"]} ref={ref} onKeyDown={onKeyDown}>
      {items.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            className="tab"
            role="tab"
            type="button"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            data-active={active ? "true" : undefined}
            onClick={() => onChange(t.value)}
          >
            {t.label}
            {t.badge != null && <span className="tag tag-neutral" style={{ marginLeft: "var(--space-2)" }}>{t.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}
