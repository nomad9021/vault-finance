import type { ReactNode } from "react";

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned toolbar: date picker, filters, primary action, etc. */
  actions?: ReactNode;
}

/** Consistent page-level header: title + optional subtitle, actions on the right. */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="page-head">
      <div style={{ minWidth: 0 }}>
        <div className="page-title">{title}</div>
        {subtitle && (
          <div style={{ fontSize: 13, color: "var(--color-neutral-500)", marginTop: 2 }}>
            {subtitle}
          </div>
        )}
      </div>
      {actions && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {actions}
        </div>
      )}
    </div>
  );
}
