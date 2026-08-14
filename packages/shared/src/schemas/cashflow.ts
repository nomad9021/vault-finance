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
 * One month on the trend charts. Net worth is reconstructed from current
 * account balances minus the transaction flows that happened after that month,
 * so it's an estimate of end-of-month net worth (asset re-pricing that isn't a
 * transaction — e.g. market moves — isn't captured).
 */
export const TrendPoint = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  netWorthCents: z.number().int(),
  incomeCents: z.number().int(),
  spendingCents: z.number().int(),
});
export type TrendPoint = z.infer<typeof TrendPoint>;

export const TrendsResponse = z.object({
  points: z.array(TrendPoint),
});
export type TrendsResponse = z.infer<typeof TrendsResponse>;

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

/**
 * Which part of the app owns a node — the answer to "if I click this, what am I
 * actually looking at, and where do I go to change it?".
 *
 * `kind` describes how a node is *drawn* (and is deliberately unchanged, so the
 * chart component and the phone viewer keep working). `section` describes what
 * it *is*, so the drill-in panel can offer the right editor and the right jump:
 * a Bills leaf edits a bill, a Savings leaf edits a goal's monthly contribution,
 * a Giving leaf edits a fund. Spending categories have no single editable row —
 * they're an aggregate of transactions — so they stay read-only with a jump.
 */
export const SankeySection = z.enum([
  "income",
  "spending",
  "bills",
  "debt",
  "savings",
  "giving",
  "saved",
]);
export type SankeySection = z.infer<typeof SankeySection>;

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
  /** Which part of the app owns this node. Absent on older servers. */
  section: SankeySection.optional(),
  /**
   * The row `section` refers to — a bill id, savings-goal id, giving-fund id, or
   * a debt's account id. Null on group headers and aggregates, which have no
   * single row behind them.
   */
  entityId: z.string().nullable().optional(),
  /**
   * The planned monthly amount currently stored for `entityId`, so the drill-in
   * panel can edit it without refetching the whole section. Editing this is what
   * changes the node's own thickness on the next load.
   */
  editableMonthlyCents: z.number().int().nullable().optional(),
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
