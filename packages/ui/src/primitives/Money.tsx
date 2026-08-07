import { formatCents, formatCentsWhole } from "@vault/shared";

export interface MoneyProps {
  cents: number;
  /** Drop the decimals — right for stat cards, wrong for a ledger. */
  whole?: boolean;
  /** Always show an explicit + or −. */
  signed?: boolean;
  /**
   * Colour by sign. "auto" greens positives and leaves negatives at the body
   * colour (spending is the norm in a ledger, so red on every row is noise);
   * "always" reds the negatives too; "none" never tints.
   */
  tone?: "auto" | "always" | "none";
  className?: string;
}

/**
 * The one place a cent value becomes text. Always tabular so columns line up
 * and a live-updating figure doesn't make the row jitter.
 */
export function Money({ cents, whole = false, signed = false, tone = "none", className }: MoneyProps) {
  const text = whole ? formatCentsWhole(cents) : formatCents(cents, { signed });
  const toneClass =
    tone === "none" ? "" : cents > 0 ? "pos" : tone === "always" && cents < 0 ? "neg" : "";
  return (
    <span className={["money", toneClass, className].filter(Boolean).join(" ")}>{text}</span>
  );
}
