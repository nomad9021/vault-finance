import {
  CreateGoalRequest,
  UpdateGoalRequest,
  type Goal as ApiGoal,
} from "@vault/shared";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { accounts, savingsGoals, transactions } from "../../db/schema.js";
import { notFound } from "../../errors.js";

/**
 * Projected completion month for a linked goal, from the linked account's
 * average net inflow over the last 90 days. Null when there's no signal.
 */
function projectCompletion(
  savedCents: number,
  targetCents: number,
  netInflow90dCents: number,
): string | null {
  if (savedCents >= targetCents) return null; // funded — nothing to project
  const perMonth = netInflow90dCents / 3;
  if (perMonth <= 0) return null;
  const monthsLeft = Math.ceil((targetCents - savedCents) / perMonth);
  if (monthsLeft > 600) return null; // effectively never — don't show a silly year
  return new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + monthsLeft, 1),
  )
    .toISOString()
    .slice(0, 7);
}

export default async function goalRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireAuth);

  async function toApi(row: typeof savingsGoals.$inferSelect): Promise<ApiGoal> {
    let savedCents = row.savedCents;
    let projectedCompletion: string | null = null;

    if (row.linkedAccountId) {
      const account = await app.db.query.accounts.findFirst({
        where: eq(accounts.id, row.linkedAccountId),
      });
      if (account) {
        savedCents = account.balanceCents;
        const cutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000)
          .toISOString()
          .slice(0, 10);
        const [inflow] = await app.db
          .select({ net: sql<string>`coalesce(sum(${transactions.amountCents}), 0)` })
          .from(transactions)
          .where(
            and(
              eq(transactions.accountId, account.id),
              gte(transactions.postedAt, cutoff),
            ),
          );
        projectedCompletion = projectCompletion(
          savedCents,
          row.targetCents,
          Number(inflow?.net ?? 0),
        );
      }
    }

    return {
      id: row.id,
      name: row.name,
      targetCents: row.targetCents,
      savedCents,
      monthlyCents: row.monthlyCents,
      linkedAccountId: row.linkedAccountId,
      targetDate: row.targetDate,
      color: row.color,
      note: row.note,
      projectedCompletion,
    };
  }

  app.get("/goals", async () => {
    const rows = await app.db.query.savingsGoals.findMany({
      where: isNull(savingsGoals.archivedAt),
      orderBy: (t, { asc }) => [asc(t.createdAt)],
    });
    return { goals: await Promise.all(rows.map(toApi)) };
  });

  app.post("/goals", async (request, reply) => {
    const body = CreateGoalRequest.parse(request.body);
    if (body.linkedAccountId) {
      const account = await app.db.query.accounts.findFirst({
        where: eq(accounts.id, body.linkedAccountId),
      });
      if (!account) throw notFound("Linked account");
    }
    const [row] = await app.db
      .insert(savingsGoals)
      .values({
        name: body.name,
        targetCents: body.targetCents,
        savedCents: body.savedCents,
        monthlyCents: body.monthlyCents,
        linkedAccountId: body.linkedAccountId ?? null,
        targetDate: body.targetDate ?? null,
        color: body.color,
        note: body.note ?? null,
      })
      .returning();
    return reply.status(201).send(await toApi(row!));
  });

  app.patch<{ Params: { id: string } }>("/goals/:id", async (request) => {
    const body = UpdateGoalRequest.parse(request.body);
    const [row] = await app.db
      .update(savingsGoals)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.targetCents !== undefined ? { targetCents: body.targetCents } : {}),
        ...(body.savedCents !== undefined ? { savedCents: body.savedCents } : {}),
        ...(body.monthlyCents !== undefined ? { monthlyCents: body.monthlyCents } : {}),
        ...(body.linkedAccountId !== undefined
          ? { linkedAccountId: body.linkedAccountId }
          : {}),
        ...(body.targetDate !== undefined ? { targetDate: body.targetDate } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
        updatedAt: new Date(),
      })
      .where(eq(savingsGoals.id, request.params.id))
      .returning();
    if (!row) throw notFound("Goal");
    return toApi(row);
  });

  app.delete<{ Params: { id: string } }>("/goals/:id", async (request, reply) => {
    const [deleted] = await app.db
      .delete(savingsGoals)
      .where(eq(savingsGoals.id, request.params.id))
      .returning({ id: savingsGoals.id });
    if (!deleted) throw notFound("Goal");
    return reply.status(204).send();
  });
}
