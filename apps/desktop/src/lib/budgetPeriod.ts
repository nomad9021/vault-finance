import type { BudgetWithSpend } from "@vault/shared";

/**
 * The figures a budget is judged on right now: this week's limit and spending
 * for a weekly budget, the month's for a monthly one. Older servers send no
 * period fields; their budgets are all monthly.
 */
export function periodFigures(b: BudgetWithSpend): { limit: number; spent: number; weekly: boolean } {
  if (b.period === "weekly") {
    return {
      limit: b.periodAmountCents ?? b.amountCents,
      spent: b.periodSpentCents ?? b.spentCents,
      weekly: true,
    };
  }
  return { limit: b.amountCents, spent: b.spentCents, weekly: false };
}
