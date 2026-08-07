import type { HTMLAttributes, ReactNode } from "react";
import { Icon } from "./Icon.js";

export interface PanelProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** Small uppercase eyebrow above the title. */
  kicker?: string;
  title?: ReactNode;
  /** Muted line under the title. */
  subtitle?: ReactNode;
  /** Right-aligned header content (buttons, toggles, a "See all" link). */
  actions?: ReactNode;
  /** Remove body padding — for panels whose children own their own edges. */
  flush?: boolean;
}

/**
 * The one true card container. Every panel across the app routes through this
 * so spacing, radius, border, elevation and header rhythm stay identical.
 */
export function Panel({
  kicker,
  title,
  subtitle,
  actions,
  flush = false,
  className,
  children,
  ...rest
}: PanelProps) {
  const hasHead = kicker || title || subtitle || actions;
  const classes = ["panel", flush ? "panel-flush" : "", className].filter(Boolean).join(" ");
  return (
    <div className={classes} {...rest}>
      {hasHead && (
        <div className={flush ? "panel-head panel-head-pad" : "panel-head"}>
          <div style={{ minWidth: 0 }}>
            {kicker && <div className="eyebrow">{kicker}</div>}
            {title && <div className="panel-title">{title}</div>}
            {subtitle && <div className="panel-sub">{subtitle}</div>}
          </div>
          {actions && <div className="panel-actions">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * The "See all →" link used in every panel header that fronts a longer list.
 * One component means the affordance reads identically everywhere.
 */
export function PanelLink({
  onClick,
  children = "See all",
}: {
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button type="button" className="panel-link" onClick={onClick}>
      {children}
      <Icon name="arrowRight" size={14} />
    </button>
  );
}
