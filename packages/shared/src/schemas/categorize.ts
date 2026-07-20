import { z } from "zod";

/**
 * Local, privacy-preserving auto-categorization. Two rule sources combine:
 * explicit user-defined keyword rules (persisted here) and merchant→category
 * mappings the engine learns from the household's own past categorizations at
 * runtime. Nothing leaves the server; the optional AI fallback is separate.
 */

export const CategorizationRule = z.object({
  id: z.string().uuid(),
  /** Case-insensitive substring matched against a transaction's merchant name. */
  keyword: z.string(),
  categoryId: z.string().uuid(),
  priority: z.number().int(),
});
export type CategorizationRule = z.infer<typeof CategorizationRule>;

export const CreateRuleRequest = z.object({
  keyword: z.string().min(1).max(100),
  categoryId: z.string().uuid(),
  priority: z.number().int().min(0).max(1000).optional(),
});
export type CreateRuleRequest = z.infer<typeof CreateRuleRequest>;

export const RuleListResponse = z.object({
  rules: z.array(CategorizationRule),
});
export type RuleListResponse = z.infer<typeof RuleListResponse>;

/** Result of a bulk auto-categorization sweep over uncategorized transactions. */
export const AutocategorizeResponse = z.object({
  /** Uncategorized transactions inspected. */
  scanned: z.number().int(),
  /** How many got a category assigned. */
  categorized: z.number().int(),
  /** Breakdown by source of the match. */
  byRule: z.number().int(),
  byHistory: z.number().int(),
});
export type AutocategorizeResponse = z.infer<typeof AutocategorizeResponse>;
