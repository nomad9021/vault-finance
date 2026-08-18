import { z } from "zod";

/**
 * A computed observation about the household's finances — an overspent budget,
 * a goal that has stalled, a bill that isn't funded yet. These are plain rules
 * over data the server already has, deliberately not AI: they must be
 * explainable, reproducible, and available whether or not an AI provider is
 * configured.
 */
export const InsightSeverity = z.enum(["critical", "warning", "info", "good"]);
export type InsightSeverity = z.infer<typeof InsightSeverity>;

export const Insight = z.object({
  id: z.string(),
  severity: InsightSeverity,
  title: z.string(),
  /** One sentence of plain language explaining what was found and why. */
  detail: z.string(),
  /** Which page resolves this, so the card can offer a button. */
  page: z.enum([
    "budgets",
    "bills",
    "goals",
    "giving",
    "transactions",
    "accounts",
    "cashflow",
    "subscriptions",
    "investments",
  ]),
  /** Optional filter carried into that page (category or account). */
  categoryId: z.string().uuid().nullable(),
  accountId: z.string().uuid().nullable(),
  /** Headline number, pre-formatted server-side as cents where it makes sense. */
  amountCents: z.number().int().nullable(),
});
export type Insight = z.infer<typeof Insight>;

export const InsightListResponse = z.object({
  insights: z.array(Insight),
  /** Counts by severity so the nav can show a badge without re-scanning. */
  criticalCount: z.number().int(),
  warningCount: z.number().int(),
});
export type InsightListResponse = z.infer<typeof InsightListResponse>;
