import type { HTMLAttributes, ReactNode } from "react";

export interface PanelProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** Small uppercase eyebrow above the title. */
  kicker?: string;
  title?: ReactNode;
  /** Muted line under the title. */
  subtitle?: ReactNode;
  /** Right-aligned header content (buttons, toggles, a "See all" link). */
  actions?: ReactNode;
  /** Remove body padding — for panels whose children own their own edges (tables, charts). */
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
            {kicker && <div className="eyebrow" style={{ marginBottom: 2 }}>{kicker}</div>}
            {title && <div className="panel-title">{title}</div>}
            {subtitle && <div className="panel-sub" style={{ marginTop: 2 }}>{subtitle}</div>}
          </div>
          {actions && <div style={{ display: "flex", alignItems: "center", gap: 8 }}>{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}
