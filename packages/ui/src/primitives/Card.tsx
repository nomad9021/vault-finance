import type { HTMLAttributes } from "react";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  elevation?: "sm" | "md" | "lg";
  kicker?: string;
  title?: string;
}

export function Card({
  elevation = "sm",
  kicker,
  title,
  className,
  children,
  ...rest
}: CardProps) {
  const classes = ["card", `elev-${elevation}`, className].filter(Boolean).join(" ");
  return (
    <div className={classes} {...rest}>
      {kicker && <div className="card-kicker">{kicker}</div>}
      {title && <div className="card-title">{title}</div>}
      {children}
    </div>
  );
}
