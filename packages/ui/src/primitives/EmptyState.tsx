import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon.js";

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  /** One sentence on what to do about it — not an apology. */
  body?: ReactNode;
  action?: ReactNode;
  /** Tighter padding, for empty panels inside a busy page. */
  compact?: boolean;
}

/**
 * The single empty state for the whole app. Every "no data yet" moment routes
 * through this so a new user meets the same shape everywhere instead of a
 * different grey sentence on each page.
 */
export function EmptyState({ icon = "inbox", title, body, action, compact = false }: EmptyStateProps) {
  return (
    <div className={compact ? "empty empty-sm" : "empty"}>
      <div className="empty-icon">
        <Icon name={icon} size={compact ? 20 : 24} />
      </div>
      <div>
        <div className="empty-title">{title}</div>
        {body && <p className="empty-body" style={{ marginTop: "var(--space-1)" }}>{body}</p>}
      </div>
      {action}
    </div>
  );
}
