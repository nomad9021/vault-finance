import { z } from "zod";

export const MonthSummary = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  incomeCents: z.number().int(),
  spendingCents: z.number().int(),
  /** income − spending. */
  netCents: z.number().int(),
  /** 0–1, null when there was no income that month. */
  savingsRate: z.number().nullable(),
});
export type MonthSummary = z.infer<typeof MonthSummary>;

export const CashflowSummaryResponse = z.object({
  months: z.array(MonthSummary),
});
export type CashflowSummaryResponse = z.infer<typeof CashflowSummaryResponse>;

/**
 * Multi-level Sankey flow data for one month, as a general graph. Columns are
 * given by `depth`: income sources (0) → total-income hub (1) → top-level
 * spending categories plus a synthetic "Saved" leaf (2) → subcategories
 * (3, 4, …) for any category with children (via parentCategoryId). The server
 * aggregates and assigns depth/links; geometry (x from depth, y stacking) is
 * the client's job.
 */
export const SankeyNodeKind = z.enum(["income", "hub", "category", "saved"]);
export type SankeyNodeKind = z.infer<typeof SankeyNodeKind>;

export const SankeyNode = z.object({
  /** "income:<uuid>", "income:other", "hub", "cat:<uuid>", or "saved". */
  id: z.string(),
  label: z.string(),
  valueCents: z.number().int().nonnegative(),
  color: z.string(),
  /** Column index: income=0, hub=1, top categories=2, subcategories 3+. */
  depth: z.number().int().nonnegative(),
  kind: SankeyNodeKind,
  /** Category id for drill-in transaction lookups (null for hub/saved/account). */
  categoryId: z.string().uuid().nullable(),
  /** Set on income nodes, which are grouped by the account the money landed in
   *  — drill-in filters transactions by this account. */
  accountId: z.string().uuid().nullable().optional(),
});
export type SankeyNode = z.infer<typeof SankeyNode>;

export const SankeyLink = z.object({
  /** Source node id. */
  from: z.string(),
  /** Target node id. */
  to: z.string(),
  valueCents: z.number().int().nonnegative(),
});
export type SankeyLink = z.infer<typeof SankeyLink>;

export const SankeyResponse = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  nodes: z.array(SankeyNode),
  links: z.array(SankeyLink),
  totalIncomeCents: z.number().int(),
  totalSpendingCents: z.number().int(),
});
export type SankeyResponse = z.infer<typeof SankeyResponse>;
