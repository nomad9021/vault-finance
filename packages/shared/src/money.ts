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
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(parseFloat(cleaned) * 100);
}
