import { useState } from "react";

/**
 * What a number field should show: the typed `text` while it still means
 * `value` (so "6." or "1.0" survive mid-typing), otherwise `show(value)`
 * (the value changed from somewhere else, like a reload).
 */
export function keptText<T>(text: string, value: T, show: (v: T) => string, parse: (t: string) => T): string {
  return show(parse(text)) === show(value) ? text : show(value);
}

/**
 * State for a number field whose text would otherwise be rebuilt from the
 * parsed number on every keystroke, turning "6." into "6" and "6.5" into "65".
 * Returns the text to show and a setter for onChange (which should also store
 * `parse(text)` as the value).
 */
export function useNumberText<T>(
  value: T,
  show: (v: T) => string,
  parse: (t: string) => T,
): [string, (text: string) => void] {
  const [text, setText] = useState(() => show(value));
  return [keptText(text, value, show, parse), setText];
}

/** DebtCalculator's APR field: digits and dots only, `Number(...) || 0`. */
export const aprText = {
  clean: (t: string) => t.replace(/[^0-9.]/g, ""),
  parse: (t: string) => Number(t.replace(/[^0-9.]/g, "")) || 0,
  show: (v: number) => String(v),
};

/** Taxes' optional % fields: empty means null, otherwise `Number(text)`. */
export const optionalPctText = {
  parse: (t: string): number | null => (t ? Number(t) : null),
  show: (v: number | null) => (v == null ? "" : String(v)),
};
