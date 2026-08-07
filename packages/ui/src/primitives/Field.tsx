import type { InputHTMLAttributes, ReactNode } from "react";
import { useId } from "react";

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  /** Validation or helper text under the input. */
  hint?: ReactNode;
  error?: string | undefined;
}

/** Labelled input following the `.field > label` + `.input` pattern. */
export function Field({ label, hint, error, id, className, ...rest }: FieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        className={["input", className].filter(Boolean).join(" ")}
        aria-invalid={error ? true : undefined}
        {...rest}
      />
      {error ? (
        <div role="alert" className="field-error">
          {error}
        </div>
      ) : hint ? (
        <div className="field-hint">{hint}</div>
      ) : null}
    </div>
  );
}
