import type { ReactNode } from "react";

export interface BannerProps {
  tone: "info" | "warning" | "danger";
  children: ReactNode;
  /** Optional action button(s) on the right. */
  action?: ReactNode;
}

const toneColor: Record<BannerProps["tone"], string> = {
  info: "var(--color-accent)",
  warning: "#d8b23c",
  danger: "var(--color-negative)",
};

/** Full-width status strip — used for the reconnecting/offline state. */
export function Banner({ tone, children, action }: BannerProps) {
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "7px 14px",
        fontSize: 13,
        background: `color-mix(in srgb, ${toneColor[tone]} 12%, var(--color-surface))`,
        borderBottom: "1px solid var(--color-divider)",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: toneColor[tone],
          animation: tone !== "info" ? "blink 1.4s infinite" : undefined,
          flex: "none",
        }}
      />
      <span style={{ flex: 1 }}>{children}</span>
      {action}
    </div>
  );
}
