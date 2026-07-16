import type { MonthSummary, SankeyNode, SankeyResponse } from "@vault/shared";
import { and, gte, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { categories, transactions } from "../../db/schema.js";

const SummaryQuery = z.object({
  months: z.coerce.number().int().min(1).max(24).default(6),
});
const SankeyQuery = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

function monthBounds(month: string): { first: string; nextFirst: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return { first: `${month}-01`, nextFirst: `${next}-01` };
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

const SAVED_COLOR = "#3ecf8e";
const OTHER_INCOME_COLOR = "#6f8ef2";

export default async function cashflowRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireAuth);

  app.get("/cashflow/summary", async (request) => {
    const { months } = SummaryQuery.parse(request.query);
    const current = new Date().toISOString().slice(0, 7);
    const start = shiftMonth(current, -(months - 1));
    const { first } = monthBounds(start);
    const { nextFirst } = monthBounds(current);

    const rows = await app.db
      .select({
        month: sql<string>`to_char(${transactions.postedAt}::date, 'YYYY-MM')`,
        income: sql<string>`coalesce(sum(${transactions.amountCents}) filter (where ${transactions.amountCents} > 0), 0)`,
        spending: sql<string>`coalesce(sum(-${transactions.amountCents}) filter (where ${transactions.amountCents} < 0), 0)`,
      })
      .from(transactions)
      .where(and(gte(transactions.postedAt, first), lt(transactions.postedAt, nextFirst)))
      .groupBy(sql`1`);
    const byMonth = new Map(rows.map((r) => [r.month, r]));

    const result: MonthSummary[] = [];
    for (let i = 0; i < months; i++) {
      const month = shiftMonth(start, i);
      const row = byMonth.get(month);
      const incomeCents = Number(row?.income ?? 0);
      const spendingCents = Number(row?.spending ?? 0);
      result.push({
        month,
        incomeCents,
        spendingCents,
        netCents: incomeCents - spendingCents,
        savingsRate:
          incomeCents > 0 ? Math.round(((incomeCents - spendingCents) / incomeCents) * 1000) / 1000 : null,
      });
    }
    return { months: result };
  });

  /**
   * Sankey aggregation: positive amounts grouped by category form the income
   * sources; negative amounts grouped by category form the spending leaves;
   * income − spending (when positive) becomes the synthetic "Saved" leaf so
   * the diagram always balances (design reference behavior).
   */
  app.get("/cashflow/sankey", async (request): Promise<SankeyResponse> => {
    const query = SankeyQuery.parse(request.query);
    const month = query.month ?? new Date().toISOString().slice(0, 7);
    const { first, nextFirst } = monthBounds(month);

    const rows = await app.db
      .select({
        categoryId: transactions.categoryId,
        income: sql<string>`coalesce(sum(${transactions.amountCents}) filter (where ${transactions.amountCents} > 0), 0)`,
        spending: sql<string>`coalesce(sum(-${transactions.amountCents}) filter (where ${transactions.amountCents} < 0), 0)`,
      })
      .from(transactions)
      .where(and(gte(transactions.postedAt, first), lt(transactions.postedAt, nextFirst)))
      .groupBy(transactions.categoryId);

    const cats = await app.db.select().from(categories);
    const catById = new Map(cats.map((c) => [c.id, c]));

    const incomes: SankeyNode[] = [];
    const leaves: SankeyNode[] = [];
    let otherIncome = 0;

    for (const row of rows) {
      const income = Number(row.income);
      const spending = Number(row.spending);
      const cat = row.categoryId ? catById.get(row.categoryId) : undefined;
      if (income > 0) {
        if (cat) {
          incomes.push({
            id: `income:${cat.id}`,
            label: cat.name,
            valueCents: income,
            color: cat.color,
            categoryId: cat.id,
          });
        } else {
          otherIncome += income;
        }
      }
      if (spending > 0) {
        leaves.push({
          id: cat ? `cat:${cat.id}` : "cat:none",
          label: cat?.name ?? "Uncategorized",
          valueCents: spending,
          color: cat?.color ?? "#9aa0ab",
          categoryId: cat?.id ?? null,
        });
      }
    }
    if (otherIncome > 0) {
      incomes.push({
        id: "income:other",
        label: "Other income",
        valueCents: otherIncome,
        color: OTHER_INCOME_COLOR,
        categoryId: null,
      });
    }

    incomes.sort((a, b) => b.valueCents - a.valueCents);
    leaves.sort((a, b) => b.valueCents - a.valueCents);

    const totalIncomeCents = incomes.reduce((sum, n) => sum + n.valueCents, 0);
    const totalSpendingCents = leaves.reduce((sum, n) => sum + n.valueCents, 0);
    if (totalIncomeCents > totalSpendingCents) {
      leaves.push({
        id: "saved",
        label: "Saved",
        valueCents: totalIncomeCents - totalSpendingCents,
        color: SAVED_COLOR,
        categoryId: null,
      });
    }

    return { month, incomes, leaves, totalIncomeCents, totalSpendingCents };
  });
}
