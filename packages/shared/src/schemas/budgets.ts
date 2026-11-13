import { z } from "zod";

/** How often a budget resets: every calendar month, or every week. */
export const BudgetPeriod = z.enum(["monthly", "weekly"]);
export type BudgetPeriod = z.infer<typeof BudgetPeriod>;

/** First day of the week for weekly budgets (matches the review setting). */
export const WeekStart = z.enum(["monday", "sunday"]);
export type WeekStart = z.infer<typeof WeekStart>;

const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const Budget = z.object({
  id: z.string().uuid(),
  categoryId: z.string().uuid(),
  /**
   * Per month, always: a weekly budget reports its monthly equivalent
   * (weekly amount × days in the month ÷ 7), so month views and totals add up.
   * The amount the user set is `periodAmountCents`.
   */
  amountCents: z.number().int(),
  rollover: z.boolean(),
  startsOn: Ymd,
  /** Absent (= monthly) on older servers, which only have monthly budgets. */
  period: BudgetPeriod.optional(),
  /** The amount per period as the user set it (per week for weekly budgets). */
  periodAmountCents: z.number().int().optional(),
});
export type Budget = z.infer<typeof Budget>;

/** A budget joined with the month's actual spending. */
export const BudgetWithSpend = Budget.extend({
  /** Spent in the requested month. */
  spentCents: z.number().int(),
  /**
   * Spent in the current period: this week for a weekly budget (or the
   * month's last week, for a past month), the month for a monthly one.
   */
  periodSpentCents: z.number().int().optional(),
  /** The current period's first day and the day after its last. */
  periodStart: Ymd.optional(),
  periodEnd: Ymd.optional(),
});
export type BudgetWithSpend = z.infer<typeof BudgetWithSpend>;

export const CreateBudgetRequest = z.object({
  categoryId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  rollover: z.boolean().default(false),
  /** Per week or per month (the default); `amountCents` is per this period. */
  period: BudgetPeriod.optional(),
  /** First month the budget applies to; defaults to the current month. */
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});
export type CreateBudgetRequest = z.infer<typeof CreateBudgetRequest>;

export const UpdateBudgetRequest = z.object({
  /** Per the budget's period (per week for a weekly budget). */
  amountCents: z.number().int().positive().optional(),
  rollover: z.boolean().optional(),
  period: BudgetPeriod.optional(),
});
export type UpdateBudgetRequest = z.infer<typeof UpdateBudgetRequest>;

export const BudgetListQuery = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  /** Where weekly budgets' weeks begin; Monday if not given. */
  weekStart: WeekStart.optional(),
});
export type BudgetListQuery = z.infer<typeof BudgetListQuery>;

export const BudgetListResponse = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  budgets: z.array(BudgetWithSpend),
  /** Whole-month totals across all categories (budgeted vs spent). */
  totalBudgetedCents: z.number().int(),
  totalSpentCents: z.number().int(),
  /**
   * The month's spending in categories with no budget (null = uncategorized),
   * so budget-vs-actual can account for all of it. The totals above leave it
   * out. Absent on older servers.
   */
  unbudgetedSpending: z
    .array(z.object({ categoryId: z.string().uuid().nullable(), spentCents: z.number().int() }))
    .optional(),
});
export type BudgetListResponse = z.infer<typeof BudgetListResponse>;

/** The single fixed monthly income figure the budget planner allocates. */
export const BudgetPlan = z.object({
  plannedIncomeCents: z.number().int().nonnegative(),
});
export type BudgetPlan = z.infer<typeof BudgetPlan>;

export const UpdateBudgetPlanRequest = BudgetPlan;
export type UpdateBudgetPlanRequest = z.infer<typeof UpdateBudgetPlanRequest>;

/**
 * What comes out of pay before it reaches the household's income: taxes,
 * pre-tax savings and paycheck deductions the user enters themselves (from a
 * pay stub). Both Sankeys draw them before income, beside — or instead of —
 * the tax profile's estimate.
 */
export const PreIncomeKind = z.enum(["tax", "pretax", "deduction"]);
export type PreIncomeKind = z.infer<typeof PreIncomeKind>;

export const PreIncomeItem = z.object({
  id: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(60),
  kind: PreIncomeKind,
  monthlyCents: z.number().int().min(0).max(100_000_000_00),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
});
export type PreIncomeItem = z.infer<typeof PreIncomeItem>;

export const PreIncome = z.object({
  items: z.array(PreIncomeItem).max(30),
  /** Also draw the tax profile's estimated taxes (off when the items are the real figures). */
  useEstimate: z.boolean(),
});
export type PreIncome = z.infer<typeof PreIncome>;
