import {
  CreateBucketRequest,
  MoveBucketMoneyRequest,
  UpdateBucketRequest,
  type Bucket,
  type BucketListResponse,
} from "@vault/shared";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { accounts, savingsBuckets, savingsGoals } from "../../db/schema.js";
import { AppError, notFound } from "../../errors.js";

/**
 * Savings buckets: dividing an account's balance into named parts. The
 * buckets are an allocation, not money of their own — they never change the
 * balance, and if the balance drops below what's allocated the account just
 * shows a negative "unassigned" for the user to rebalance.
 */

const COLORS = ["#3ecf8e", "#6f8ef2", "#ec6a9c", "#d8b23c", "#b47ef0", "#43cfc0", "#f08a4b"];

function toApi(row: typeof savingsBuckets.$inferSelect): Bucket {
  return {
    id: row.id,
    accountId: row.accountId,
    name: row.name,
    color: row.color,
    allocatedCents: row.allocatedCents,
    targetCents: row.targetCents,
    goalId: row.goalId,
    sortOrder: row.sortOrder,
  };
}

export default async function bucketRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireAuth);

  const account = async (id: string) => {
    const row = await app.db.query.accounts.findFirst({ where: and(eq(accounts.id, id), isNull(accounts.archivedAt)) });
    if (!row) throw notFound("Account");
    if (row.isLiability) throw new AppError("VALIDATION_ERROR", 400, "Buckets divide money you have — pick a savings or checking account.");
    return row;
  };
  const bucket = async (id: string) => {
    const row = await app.db.query.savingsBuckets.findFirst({ where: eq(savingsBuckets.id, id) });
    if (!row) throw notFound("Bucket");
    return row;
  };
  const checkGoal = async (goalId: string | null | undefined, bucketId?: string) => {
    if (!goalId) return;
    const goal = await app.db.query.savingsGoals.findFirst({ where: eq(savingsGoals.id, goalId) });
    if (!goal) throw notFound("Goal");
    const taken = await app.db.query.savingsBuckets.findFirst({ where: eq(savingsBuckets.goalId, goalId) });
    if (taken && taken.id !== bucketId) throw new AppError("VALIDATION_ERROR", 400, `"${goal.name}" is already linked to the "${taken.name}" bucket.`);
  };

  // Every money account (savings first), with its buckets and what's unassigned.
  app.get("/buckets", async (): Promise<BucketListResponse> => {
    const accts = await app.db.query.accounts.findMany({
      where: and(isNull(accounts.archivedAt), eq(accounts.isLiability, false)),
      orderBy: [asc(accounts.createdAt)],
    });
    const rows = await app.db.query.savingsBuckets.findMany({ orderBy: [asc(savingsBuckets.sortOrder), asc(savingsBuckets.createdAt)] });
    const order = (t: string) => (t === "savings" ? 0 : t === "checking" ? 1 : 2);
    return {
      accounts: accts
        .filter((a) => a.type !== "investment")
        .sort((a, b) => order(a.type) - order(b.type))
        .map((a) => {
          const buckets = rows.filter((b) => b.accountId === a.id).map(toApi);
          const allocated = buckets.reduce((s, b) => s + b.allocatedCents, 0);
          return {
            accountId: a.id,
            accountName: a.name,
            accountType: a.type,
            balanceCents: a.balanceCents,
            allocatedCents: allocated,
            unassignedCents: a.balanceCents - allocated,
            buckets,
          };
        }),
    };
  });

  app.post("/buckets", async (request, reply) => {
    const body = CreateBucketRequest.parse(request.body);
    await account(body.accountId);
    await checkGoal(body.goalId);
    const [{ n }] = (await app.db
      .select({ n: sql<number>`count(*)::int` })
      .from(savingsBuckets)
      .where(eq(savingsBuckets.accountId, body.accountId))) as [{ n: number }];
    const [row] = await app.db
      .insert(savingsBuckets)
      .values({
        accountId: body.accountId,
        name: body.name,
        color: body.color ?? COLORS[n % COLORS.length]!,
        allocatedCents: body.allocatedCents ?? 0,
        targetCents: body.targetCents ?? null,
        goalId: body.goalId ?? null,
        sortOrder: n,
      })
      .returning();
    return reply.status(201).send(toApi(row!));
  });

  app.patch<{ Params: { id: string } }>("/buckets/:id", async (request) => {
    const body = UpdateBucketRequest.parse(request.body);
    await bucket(request.params.id);
    if (body.goalId !== undefined) await checkGoal(body.goalId, request.params.id);
    const [row] = await app.db
      .update(savingsBuckets)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.allocatedCents !== undefined ? { allocatedCents: body.allocatedCents } : {}),
        ...(body.targetCents !== undefined ? { targetCents: body.targetCents } : {}),
        ...(body.goalId !== undefined ? { goalId: body.goalId } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
        updatedAt: new Date(),
      })
      .where(eq(savingsBuckets.id, request.params.id))
      .returning();
    return toApi(row!);
  });

  app.delete<{ Params: { id: string } }>("/buckets/:id", async (request, reply) => {
    await bucket(request.params.id);
    await app.db.delete(savingsBuckets).where(eq(savingsBuckets.id, request.params.id));
    return reply.status(204).send();
  });

  // Move an amount between two buckets of the same account (null = unassigned).
  app.post("/buckets/move", async (request) => {
    const body = MoveBucketMoneyRequest.parse(request.body);
    if (body.fromBucketId === body.toBucketId) throw new AppError("VALIDATION_ERROR", 400, "Pick two different buckets.");
    if (!body.fromBucketId && !body.toBucketId) throw new AppError("VALIDATION_ERROR", 400, "Pick at least one bucket.");
    const from = body.fromBucketId ? await bucket(body.fromBucketId) : null;
    const to = body.toBucketId ? await bucket(body.toBucketId) : null;
    const accountId = (from ?? to)!.accountId;
    if (from && to && from.accountId !== to.accountId) throw new AppError("VALIDATION_ERROR", 400, "Buckets can only share money within one account.");
    if (from && from.allocatedCents < body.amountCents) {
      throw new AppError("VALIDATION_ERROR", 400, `"${from.name}" only has ${(from.allocatedCents / 100).toFixed(2)}.`);
    }
    if (!from) {
      const acct = await account(accountId);
      const allocated = (await app.db.query.savingsBuckets.findMany({ where: eq(savingsBuckets.accountId, accountId) })).reduce((s, b) => s + b.allocatedCents, 0);
      if (acct.balanceCents - allocated < body.amountCents) {
        throw new AppError("VALIDATION_ERROR", 400, `Only ${((acct.balanceCents - allocated) / 100).toFixed(2)} is unassigned in ${acct.name}.`);
      }
    }
    await app.db.transaction(async (tx) => {
      if (from) await tx.update(savingsBuckets).set({ allocatedCents: from.allocatedCents - body.amountCents, updatedAt: new Date() }).where(eq(savingsBuckets.id, from.id));
      if (to) await tx.update(savingsBuckets).set({ allocatedCents: to.allocatedCents + body.amountCents, updatedAt: new Date() }).where(eq(savingsBuckets.id, to.id));
    });
    return { ok: true };
  });
}
