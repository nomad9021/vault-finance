import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./Icon.js";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "glass";
  size?: "sm" | "md" | "lg";
  /** Leading icon. With no children this becomes a square icon-only button. */
  icon?: IconName;
  /** Trailing icon — for "See all →" style affordances. */
  iconEnd?: IconName;
  /** Full-width. */
  block?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  iconEnd,
  block = false,
  className,
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  const iconOnly = !!icon && children == null;
  const iconSize = size === "sm" ? 15 : size === "lg" ? 19 : 17;
  const classes = [
    "btn",
    `btn-${variant}`,
    size !== "md" && `btn-${size}`,
    iconOnly && "btn-icon",
    block && "btn-block",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type={type} className={classes} {...rest}>
      {icon && <Icon name={icon} size={iconSize} />}
      {children}
      {iconEnd && <Icon name={iconEnd} size={iconSize} />}
    </button>
  );
}
