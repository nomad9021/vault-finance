/**
 * Money helpers. Everything over the wire is integer cents (api-design.md);
 * these are the only places cents become display strings and back.
 */

export function formatCents(
  cents: number,
  { currency = "USD", signed = false }: { currency?: string; signed?: boolean } = {},
): string {
  const formatter = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const abs = formatter.format(Math.abs(cents) / 100);
  if (signed) return `${cents < 0 ? "−" : "+"}${abs}`;
  return cents < 0 ? `−${abs}` : abs;
}

/** Whole-dollar display for stat cards ("$12,480"). */
export function formatCentsWhole(cents: number, currency = "USD"): string {
  const formatter = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  });
  const abs = formatter.format(Math.round(Math.abs(cents) / 100));
  return cents < 0 ? `−${abs}` : abs;
}

/**
 * Parse a user-entered amount ("1,234.56", "$12", "-3.5") into cents.
 * Returns null for anything that isn't a clean number.
 */
export function parseAmountToCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, "").replace(/^−/, "-");
  const match = /^(-?)(?:(\d+)(?:\.(\d{0,2}))?|\.(\d{1,2}))$/.exec(cleaned);
  if (!match) return null;
  // Whole-number arithmetic on the digits, so no float can shift a cent.
  const dollars = Number(match[2] ?? 0);
  const fraction = (match[3] ?? match[4] ?? "").padEnd(2, "0");
  const cents = dollars * 100 + Number(fraction);
  if (!Number.isSafeInteger(cents)) return null;
  return match[1] && cents !== 0 ? -cents : cents;
}

/**
 * The exact text to put in an amount field for a stored value ("600.05"), with
 * no currency symbol or separators. A field must show every cent it holds: one
 * showing a rounded figure writes the rounding back when it is saved.
 */
export function centsToAmountInput(cents: number): string {
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}${whole}.${fraction}`;
}
