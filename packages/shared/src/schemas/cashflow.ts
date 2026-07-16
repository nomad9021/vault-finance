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
 * Sankey flow data for one month: income sources (left) → total-income hub →
 * spending categories plus a synthetic "Saved" leaf (right). Geometry is the
 * client's job (the ported sankeyGeo layout); the server only aggregates.
 */
export const SankeyNode = z.object({
  /** "cat:<uuid>", "income:<uuid>", "income:other", or "saved". */
  id: z.string(),
  label: z.string(),
  valueCents: z.number().int().nonnegative(),
  color: z.string(),
  /** Category id for drill-in transaction lookups (absent for "saved"). */
  categoryId: z.string().uuid().nullable(),
});
export type SankeyNode = z.infer<typeof SankeyNode>;

export const SankeyResponse = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  incomes: z.array(SankeyNode),
  leaves: z.array(SankeyNode),
  totalIncomeCents: z.number().int(),
  totalSpendingCents: z.number().int(),
});
export type SankeyResponse = z.infer<typeof SankeyResponse>;
