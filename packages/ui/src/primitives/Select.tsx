import type { ReactNode, SelectHTMLAttributes } from "react";
import { useId } from "react";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  children: ReactNode;
}

/** Native select styled with the design's `.input` class. */
export function Select({ label, id, className, children, ...rest }: SelectProps) {
  const autoId = useId();
  const selectId = id ?? autoId;
  const select = (
    <select
      id={selectId}
      className={["input", className].filter(Boolean).join(" ")}
      {...rest}
    >
      {children}
    </select>
  );
  if (!label) return select;
  return (
    <div className="field">
      <label htmlFor={selectId}>{label}</label>
      {select}
    </div>
  );
}
