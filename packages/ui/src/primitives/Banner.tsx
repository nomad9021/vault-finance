import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon.js";

export interface BannerProps {
  tone: "info" | "warning" | "danger" | "positive";
  children: ReactNode;
  /** Optional action button(s) on the right. */
  action?: ReactNode;
}

const ICONS: Record<BannerProps["tone"], IconName> = {
  info: "info",
  warning: "alert",
  danger: "alert",
  positive: "check",
};

/** Full-width status strip — used for the reconnecting/offline state. */
export function Banner({ tone, children, action }: BannerProps) {
  return (
    <div role="status" className={`banner banner-${tone}`}>
      <Icon name={ICONS[tone]} size={17} style={{ flex: "none" }} />
      <span style={{ flex: 1 }}>{children}</span>
      {action}
    </div>
  );
}
