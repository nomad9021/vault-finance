import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon.js";

export interface MetricCardProps {
  label: string;
  value: ReactNode;
  /** Signed change line, e.g. "+$1,240 (2.5%)". Coloured by `deltaTone`. */
  delta?: ReactNode;
  deltaTone?: "up" | "down" | "muted";
  /** Small hint under the value (or a call-to-action when clickable). */
  hint?: ReactNode;
  /** Large hero value (e.g. Net worth). */
  large?: boolean;
  icon?: IconName;
  onClick?: () => void;
}

/**
 * A single financial metric: quiet uppercase label, a dominant tabular number,
 * and an optional change/hint. The whole card can be a navigation target — the
 * chevron only appears then, so a static metric doesn't imply a click.
 */
export function MetricCard({
  label,
  value,
  delta,
  deltaTone = "muted",
  hint,
  large = false,
  icon,
  onClick,
}: MetricCardProps) {
  const interactive = !!onClick;
  const deltaClass = deltaTone === "up" ? "pos" : deltaTone === "down" ? "neg" : "";
  const arrow = deltaTone === "up" ? "trendUp" : deltaTone === "down" ? "trendDown" : null;

  return (
    <div
      className={["panel", "stat", interactive ? "clickable" : ""].filter(Boolean).join(" ")}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        interactive
          ? (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onClick())
          : undefined
      }
    >
      <div className="row" style={{ gap: "var(--space-2)" }}>
        {icon && (
          <span className="tile" style={{ width: 26, height: 26, borderRadius: "var(--radius-sm)" }}>
            <Icon name={icon} size={15} />
          </span>
        )}
        <span className="stat-label">{label}</span>
        {interactive && (
          <Icon
            name="chevronRight"
            size={15}
            style={{ marginLeft: "auto", color: "var(--content-tertiary)" }}
          />
        )}
      </div>
      <div className={large ? "stat-value stat-value-lg" : "stat-value"}>{value}</div>
      {delta && (
        <div className={`stat-delta ${deltaClass}`}>
          {arrow && <Icon name={arrow} size={13} />}
          {delta}
        </div>
      )}
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}
