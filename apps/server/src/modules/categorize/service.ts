import { eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../plugins/db.js";
import { categories, categorizationRules, transactions } from "../../db/schema.js";
import { AI_FEATURE_QUALITY } from "@vault/shared";
import { configForQuality } from "../ai/model-manager.js";
import { getProvider, isConfigured } from "../ai/providers/index.js";
import { resolveSettings } from "../ai/settings.js";
import {
  learnFromHistory,
  normalizeMerchant,
  suggestCategory,
  type Rule,
  type Suggestion,
} from "./engine.js";

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

/** Resolve an AI answer to one of the household's category ids, or null. */
function matchCategory(answer: string, cats: { id: string; name: string }[]): string | null {
  const a = answer.trim().toLowerCase();
  if (!a || a === "unknown" || a === "none") return null;
  // Exact name match first, then a contained-name match (models add words).
  const exact = cats.find((c) => c.name.toLowerCase() === a);
  if (exact) return exact.id;
  const contained = cats.find((c) => a.includes(c.name.toLowerCase()));
  return contained?.id ?? null;
}

/**
 * The "leftovers" pass: for transactions that keyword rules and learned history
 * couldn't place, ask the configured AI provider to pick a category. Runs only
 * when AI is enabled AND configured — with Ollama that means everything stays
 * on the user's own hardware. Merchants are de-duplicated so each distinct
 * merchant costs at most one model call, and the result feeds history so the
 * same merchant is free (and instant) next time.
 */
export async function aiCategorizeUncategorized(
  app: FastifyInstance,
  config: AppConfig,
): Promise<number> {
  const settings = await resolveSettings(app, config);
  if (!settings.enabled || !isConfigured(settings.aiConfig)) return 0;

  const pending = await app.db
    .select({ id: transactions.id, merchantName: transactions.merchantName })
    .from(transactions)
    .where(isNull(transactions.categoryId));
  if (pending.length === 0) return 0;

  const cats = await app.db
    .select({ id: categories.id, name: categories.name })
    .from(categories);
  if (cats.length === 0) return 0;

  // Group the uncategorized transactions by normalized merchant.
  const byMerchant = new Map<string, { display: string; ids: string[] }>();
  for (const p of pending) {
    const key = normalizeMerchant(p.merchantName);
    if (!key) continue;
    const entry = byMerchant.get(key) ?? { display: p.merchantName, ids: [] };
    entry.ids.push(p.id);
    byMerchant.set(key, entry);
  }

  const provider = getProvider(settings.provider);
  const aiConfig = configForQuality(settings, AI_FEATURE_QUALITY.categorize);
  const nameList = cats.map((c) => c.name).join(", ");
  let categorized = 0;
  // Cap the number of model calls per pass so a huge backlog can't stall a sync.
  const merchants = [...byMerchant.values()].slice(0, 50);
  for (const { display, ids } of merchants) {
    const prompt =
      `You are a strict personal-finance transaction categorizer. ` +
      `Choose the single best category for a purchase, using EXACTLY one name from this list: ${nameList}. ` +
      `If none clearly fit, reply "Unknown". Reply with only the category name, nothing else. ` +
      `Merchant: "${display}"`;
    let answer: string;
    try {
      answer = await provider.generateText(aiConfig, prompt);
    } catch {
      continue; // provider hiccup on one merchant shouldn't abort the batch
    }
    const categoryId = matchCategory(answer, cats);
    if (!categoryId) continue;
    await app.db
      .update(transactions)
      .set({ categoryId, updatedAt: new Date() })
      .where(inArray(transactions.id, ids));
    categorized += ids.length;
  }
  return categorized;
}
