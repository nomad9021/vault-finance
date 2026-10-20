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

export const ReviewPeriod = z.enum(["week", "month"]);
export type ReviewPeriod = z.infer<typeof ReviewPeriod>;

export const ReviewQuery = z.object({
  period: ReviewPeriod.default("month"),
  /** First day of the period. Defaults to the current week (Monday) or month. */
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type ReviewQuery = z.infer<typeof ReviewQuery>;

export const ReviewTotals = z.object({
  incomeCents: z.number().int(),
  spendingCents: z.number().int(),
  savedCents: z.number().int(),
  transactionCount: z.number().int(),
});
export type ReviewTotals = z.infer<typeof ReviewTotals>;

export const ReviewMerchant = z.object({
  name: z.string(),
  spentCents: z.number().int(),
  count: z.number().int(),
});
export type ReviewMerchant = z.infer<typeof ReviewMerchant>;

export const ReviewTransaction = z.object({
  id: z.string().uuid(),
  postedAt: z.string(),
  merchantName: z.string(),
  amountCents: z.number().int(),
  categoryName: z.string(),
  color: z.string(),
});
export type ReviewTransaction = z.infer<typeof ReviewTransaction>;

/**
 * A weekly or monthly finance review — the data behind the presenter
 * slideshow. Covers [start, end); `previous` is the same-length period just
 * before it, for "vs last week/month" comparisons.
 */
export const PeriodReview = ReviewTotals.extend({
  period: ReviewPeriod,
  start: z.string(),
  /** Exclusive end date. */
  end: z.string(),
  savingsRate: z.number().nullable(),
  previous: ReviewTotals,
  /** Spending by category, largest first, with the previous period's figure. */
  categories: z.array(CategorySpend.extend({ previousSpentCents: z.number().int() })),
  topMerchants: z.array(ReviewMerchant),
  largestPurchases: z.array(ReviewTransaction),
  /** One entry per day of the period, zero-filled. */
  dailySpending: z.array(z.object({ date: z.string(), spentCents: z.number().int() })),
});
export type PeriodReview = z.infer<typeof PeriodReview>;
