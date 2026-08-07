import type { HTMLAttributes } from "react";

export interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: "accent" | "accent-2" | "neutral" | "positive" | "negative" | "warning" | "outline";
}

export function Tag({ variant = "neutral", className, ...rest }: TagProps) {
  const classes = ["tag", `tag-${variant}`, className].filter(Boolean).join(" ");
  return <span className={classes} {...rest} />;
}
