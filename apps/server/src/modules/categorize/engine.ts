/**
 * Pure, local categorization engine. No network, no AI — it works entirely
 * from the household's own data: explicit keyword rules the user defined, and
 * merchant→category mappings learned from transactions already categorized.
 * Kept side-effect-free so it's trivially unit-testable; the route layer does
 * the DB reads/writes.
 */

export interface Rule {
  keyword: string;
  categoryId: string;
  priority: number;
}

export interface HistoryRow {
  merchantName: string;
  categoryId: string | null;
}

export type Suggestion = { categoryId: string; source: "rule" | "history" } | null;

/**
 * Canonical form of a merchant name for matching: uppercased, punctuation and
 * digits stripped, whitespace collapsed. "SQ *Blue Bottle #1234" and
 * "BLUE BOTTLE" both reduce toward "BLUE BOTTLE" so learned mappings generalize
 * across the noisy suffixes banks append.
 */
export function normalizeMerchant(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build a merchant→category lookup from already-categorized history. When a
 * merchant was filed under several categories, the most frequent wins (ties
 * broken by whichever reached the count first, i.e. insertion order).
 */
export function learnFromHistory(rows: HistoryRow[]): Map<string, string> {
  // normalized merchant → (categoryId → count)
  const tally = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (!row.categoryId) continue;
    const key = normalizeMerchant(row.merchantName);
    if (!key) continue;
    const counts = tally.get(key) ?? new Map<string, number>();
    counts.set(row.categoryId, (counts.get(row.categoryId) ?? 0) + 1);
    tally.set(key, counts);
  }
  const learned = new Map<string, string>();
  for (const [key, counts] of tally) {
    let bestId: string | null = null;
    let bestCount = 0;
    for (const [categoryId, count] of counts) {
      if (count > bestCount) {
        bestCount = count;
        bestId = categoryId;
      }
    }
    if (bestId) learned.set(key, bestId);
  }
  return learned;
}

/**
 * Highest-priority explicit rule whose keyword appears (case-insensitively) in
 * the merchant name, or null. Ties broken by longer keyword (more specific).
 */
export function matchExplicitRule(merchantName: string, rules: Rule[]): string | null {
  const haystack = merchantName.toUpperCase();
  let best: Rule | null = null;
  for (const rule of rules) {
    const needle = rule.keyword.toUpperCase().trim();
    if (!needle || !haystack.includes(needle)) continue;
    if (
      !best ||
      rule.priority > best.priority ||
      (rule.priority === best.priority && needle.length > best.keyword.trim().length)
    ) {
      best = rule;
    }
  }
  return best?.categoryId ?? null;
}

/**
 * Suggest a category for one merchant: explicit rules win, then learned
 * history. Returns null when nothing matches (the AI fallback, if enabled,
 * handles those separately).
 */
export function suggestCategory(
  merchantName: string,
  rules: Rule[],
  learned: Map<string, string>,
): Suggestion {
  const ruleHit = matchExplicitRule(merchantName, rules);
  if (ruleHit) return { categoryId: ruleHit, source: "rule" };
  const histHit = learned.get(normalizeMerchant(merchantName));
  if (histHit) return { categoryId: histHit, source: "history" };
  return null;
}
