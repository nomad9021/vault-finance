import { z } from "zod";

export const Budget = z.object({
  id: z.string().uuid(),
  categoryId: z.string().uuid(),
  amountCents: z.number().int(),
  rollover: z.boolean(),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type Budget = z.infer<typeof Budget>;

/** A budget joined with the month's actual spending. */
export const BudgetWithSpend = Budget.extend({
  spentCents: z.number().int(),
});
export type BudgetWithSpend = z.infer<typeof BudgetWithSpend>;

export const CreateBudgetRequest = z.object({
  categoryId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  rollover: z.boolean().default(false),
  /** First month the budget applies to; defaults to the current month. */
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});
export type CreateBudgetRequest = z.infer<typeof CreateBudgetRequest>;

export const UpdateBudgetRequest = z.object({
  amountCents: z.number().int().positive().optional(),
  rollover: z.boolean().optional(),
});
export type UpdateBudgetRequest = z.infer<typeof UpdateBudgetRequest>;

export const BudgetListQuery = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});
export type BudgetListQuery = z.infer<typeof BudgetListQuery>;

export const BudgetListResponse = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  budgets: z.array(BudgetWithSpend),
  /** Whole-month totals across all categories (budgeted vs spent). */
  totalBudgetedCents: z.number().int(),
  totalSpentCents: z.number().int(),
});
export type BudgetListResponse = z.infer<typeof BudgetListResponse>;
