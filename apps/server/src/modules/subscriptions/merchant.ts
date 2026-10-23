/**
 * Merchant names arrive with transaction noise — store numbers, dates, card
 * suffixes. Normalizing lets "AMZN Mktp US*2K4L" and "AMZN Mktp US*9F1C" land in
 * the same bucket, which is the difference between spotting a subscription and
 * seeing thirty one-offs.
 */
export function normalizeMerchant(name: string): string {
  return name
    .toLowerCase()
    .replace(/[*#]\w+/g, " ")
    .replace(/\b\d[\d-]*\b/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Does a bill's name refer to this (normalized) merchant? Whole words only:
 * every word of one appears in the other, so "Netflix" matches "netflix com"
 * but a bill called "Rent" doesn't swallow "Lakeside Rentals".
 */
export function billMatchesMerchant(billName: string, merchantKey: string): boolean {
  const billKey = normalizeMerchant(billName);
  if (billKey.length <= 2 || merchantKey.length === 0) return false;
  const billWords = new Set(billKey.split(" "));
  const merchantWords = new Set(merchantKey.split(" "));
  const within = (a: Set<string>, b: Set<string>) => [...a].every((w) => b.has(w));
  return within(billWords, merchantWords) || within(merchantWords, billWords);
}
