import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
  /** 36×36 icon-only button. */
  icon?: boolean;
  /** Full-width. */
  block?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = "secondary",
  icon = false,
  block = false,
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  const classes = [
    "btn",
    `btn-${variant}`,
    icon && "btn-icon",
    block && "btn-block",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return <button type={type} className={classes} {...rest} />;
}
