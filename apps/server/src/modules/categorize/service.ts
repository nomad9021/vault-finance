import { eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../../plugins/db.js";
import { categorizationRules, transactions } from "../../db/schema.js";
import { learnFromHistory, suggestCategory, type Rule, type Suggestion } from "./engine.js";

export interface Categorizer {
  suggest: (merchantName: string) => Suggestion;
  /** True when there's anything to match against (rules or learned history). */
  hasSignals: boolean;
}

/**
 * Snapshot the household's categorization signals — explicit rules plus a
 * merchant→category map learned from already-categorized transactions — into a
 * pure `suggest()` closure. Read-only; load once and reuse across a batch.
 */
export async function loadCategorizer(db: Db): Promise<Categorizer> {
  const ruleRows = await db.select().from(categorizationRules);
  const rules: Rule[] = ruleRows.map((r) => ({
    keyword: r.keyword,
    categoryId: r.categoryId,
    priority: r.priority,
  }));
  const history = await db
    .select({ merchantName: transactions.merchantName, categoryId: transactions.categoryId })
    .from(transactions)
    .where(isNotNull(transactions.categoryId));
  const learned = learnFromHistory(history);
  return {
    suggest: (m) => suggestCategory(m, rules, learned),
    hasSignals: rules.length > 0 || learned.size > 0,
  };
}

export interface SweepResult {
  scanned: number;
  categorized: number;
  byRule: number;
  byHistory: number;
}

/**
 * Assign categories to every currently-uncategorized transaction the engine
 * can match. Only fills empty categories — a user's explicit choice is never
 * overwritten. Category updates don't affect account balances, so no balance
 * bookkeeping is needed.
 */
export async function sweepUncategorized(db: Db): Promise<SweepResult> {
  const categorizer = await loadCategorizer(db);
  const pending = await db
    .select({ id: transactions.id, merchantName: transactions.merchantName })
    .from(transactions)
    .where(isNull(transactions.categoryId));

  const result: SweepResult = { scanned: pending.length, categorized: 0, byRule: 0, byHistory: 0 };
  if (!categorizer.hasSignals) return result;

  for (const t of pending) {
    const suggestion: Suggestion = categorizer.suggest(t.merchantName);
    if (!suggestion) continue;
    await db
      .update(transactions)
      .set({ categoryId: suggestion.categoryId, updatedAt: new Date() })
      .where(eq(transactions.id, t.id));
    result.categorized++;
    if (suggestion.source === "rule") result.byRule++;
    else result.byHistory++;
  }
  return result;
}
