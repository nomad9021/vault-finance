import { z } from "zod";
import { MonthSummary } from "./cashflow.js";

export const CategorySpend = z.object({
  categoryId: z.string().uuid().nullable(),
  name: z.string(),
  color: z.string(),
  spentCents: z.number().int(),
});
export type CategorySpend = z.infer<typeof CategorySpend>;

export const MonthlyReport = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  incomeCents: z.number().int(),
  spendingCents: z.number().int(),
  savedCents: z.number().int(),
  savingsRate: z.number().nullable(),
  topCategories: z.array(CategorySpend),
  /**
   * AI commentary, generated once per closed month and cached server-side
   * (monthly_report_snapshots). Null when AI is disabled/unreachable and
   * nothing was cached — the report is fully useful without it.
   */
  aiSummary: z.string().nullable(),
});
export type MonthlyReport = z.infer<typeof MonthlyReport>;

export const YearlyReport = z.object({
  year: z.number().int(),
  months: z.array(MonthSummary),
  totalIncomeCents: z.number().int(),
  totalSpendingCents: z.number().int(),
  totalSavedCents: z.number().int(),
  savingsRate: z.number().nullable(),
});
export type YearlyReport = z.infer<typeof YearlyReport>;
