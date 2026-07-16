import {
  BudgetListQuery,
  CreateBudgetRequest,
  UpdateBudgetRequest,
  type Budget as ApiBudget,
} from "@vault/shared";
import { and, eq, gte, lt, lte, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { budgets, categories, transactions } from "../../db/schema.js";
import { AppError, notFound } from "../../errors.js";

function toApi(row: typeof budgets.$inferSelect): ApiBudget {
  return {
    id: row.id,
    categoryId: row.categoryId,
    amountCents: row.amountCents,
    rollover: row.rollover,
    startsOn: row.startsOn,
  };
}

function monthBounds(month: string): { first: string; nextFirst: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const first = `${month}-01`;
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return { first, nextFirst: `${next}-01` };
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export default async function budgetRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireAuth);

  /**
   * Budgets are month-versioned: a row applies from its startsOn month until
   * a newer row exists for the same category. GET returns, per category, the
   * latest row that had started by the requested month, joined with that
   * month's spending (spending = −sum of negative amounts; see the sign
   * convention in @vault/shared).
   */
  app.get("/budgets", async (request) => {
    const query = BudgetListQuery.parse(request.query);
    const month = query.month ?? currentMonth();
    const { first, nextFirst } = monthBounds(month);

    const allBudgets = await app.db
      .select()
      .from(budgets)
      .where(lte(budgets.startsOn, first))
      .orderBy(budgets.categoryId, sql`${budgets.startsOn} desc`);

    // Latest per category (rows arrive ordered startsOn desc within category).
    const latest = new Map<string, typeof budgets.$inferSelect>();
    for (const b of allBudgets) {
      if (!latest.has(b.categoryId)) latest.set(b.categoryId, b);
    }

    const spentRows = await app.db
      .select({
        categoryId: transactions.categoryId,
        spent: sql<number>`coalesce(sum(-${transactions.amountCents}) filter (where ${transactions.amountCents} < 0), 0)::bigint`,
      })
      .from(transactions)
      .where(and(gte(transactions.postedAt, first), lt(transactions.postedAt, nextFirst)))
      .groupBy(transactions.categoryId);
    const spentByCategory = new Map(
      spentRows.map((r) => [r.categoryId ?? "none", Number(r.spent)]),
    );

    const result = [...latest.values()].map((b) => ({
      ...toApi(b),
      spentCents: spentByCategory.get(b.categoryId) ?? 0,
    }));

    return {
      month,
      budgets: result,
      totalBudgetedCents: result.reduce((sum, b) => sum + b.amountCents, 0),
      totalSpentCents: result.reduce((sum, b) => sum + b.spentCents, 0),
    };
  });

  app.post("/budgets", async (request, reply) => {
    const body = CreateBudgetRequest.parse(request.body);
    const category = await app.db.query.categories.findFirst({
      where: eq(categories.id, body.categoryId),
    });
    if (!category) throw notFound("Category");

    const startsOn = `${body.month ?? currentMonth()}-01`;
    const [row] = await app.db
      .insert(budgets)
      .values({
        categoryId: body.categoryId,
        amountCents: body.amountCents,
        rollover: body.rollover,
        startsOn,
      })
      .onConflictDoUpdate({
        target: [budgets.categoryId, budgets.startsOn],
        set: { amountCents: body.amountCents, rollover: body.rollover, updatedAt: new Date() },
      })
      .returning();
    return reply.status(201).send(toApi(row!));
  });

  app.patch<{ Params: { id: string } }>("/budgets/:id", async (request) => {
    const body = UpdateBudgetRequest.parse(request.body);
    if (body.amountCents === undefined && body.rollover === undefined) {
      throw new AppError("VALIDATION_ERROR", 400, "Nothing to update.");
    }
    const [row] = await app.db
      .update(budgets)
      .set({
        ...(body.amountCents !== undefined ? { amountCents: body.amountCents } : {}),
        ...(body.rollover !== undefined ? { rollover: body.rollover } : {}),
        updatedAt: new Date(),
      })
      .where(eq(budgets.id, request.params.id))
      .returning();
    if (!row) throw notFound("Budget");
    return toApi(row);
  });

  app.delete<{ Params: { id: string } }>("/budgets/:id", async (request, reply) => {
    const [deleted] = await app.db
      .delete(budgets)
      .where(eq(budgets.id, request.params.id))
      .returning({ id: budgets.id });
    if (!deleted) throw notFound("Budget");
    return reply.status(204).send();
  });
}
