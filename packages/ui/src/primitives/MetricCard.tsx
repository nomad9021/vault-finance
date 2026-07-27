import type { ReactNode } from "react";

export interface MetricCardProps {
  label: string;
  value: ReactNode;
  /** Signed change line, e.g. "+$1,240 (2.5%)". Colored by `deltaTone`. */
  delta?: ReactNode;
  deltaTone?: "up" | "down" | "muted";
  /** Small hint under the value (or a call-to-action when clickable). */
  hint?: ReactNode;
  /** Large hero value (e.g. Net worth). */
  large?: boolean;
  icon?: ReactNode;
  onClick?: () => void;
}

/**
 * A single financial metric: quiet uppercase label, a dominant tabular number,
 * and an optional change/hint. The whole card can be a navigation target.
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
  return (
    <div
      className={["panel", interactive ? "clickable" : ""].filter(Boolean).join(" ")}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        interactive
          ? (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onClick!())
          : undefined
      }
      style={{ display: "flex", flexDirection: "column", gap: 6 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {icon}
        <span className="eyebrow">{label}</span>
      </div>
      <div className={large ? "metric-value metric-value-lg" : "metric-value"}>{value}</div>
      {delta && (
        <div className={`num ${deltaClass}`} style={{ fontSize: 12.5, fontWeight: 600 }}>
          {delta}
        </div>
      )}
      {hint && (
        <div style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>{hint}</div>
      )}
    </div>
  );
}
