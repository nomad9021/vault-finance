import {
  ContributeGivingRequest,
  CreateGivingFundRequest,
  UpdateGivingFundRequest,
  type GivingFund as ApiGivingFund,
  type GivingKind,
} from "@vault/shared";
import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { accounts, givingFunds, transactions } from "../../db/schema.js";
import { notFound } from "../../errors.js";

/** Whole days from today (UTC) to a YYYY-MM-DD date; negative once it's past. */
function daysUntil(date: string, today = new Date()): number {
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((Date.parse(`${date}T00:00:00Z`) - todayUtc) / 86_400_000);
}

/**
 * What this fund needs per month to be ready on time. Only meaningful for a
 * gift fund with both a target and a date; returns null when it's already
 * funded, and treats "due this month or overdue" as needing the whole shortfall
 * now rather than dividing by zero.
 */
function neededMonthly(
  targetCents: number | null,
  savedCents: number,
  occasionDate: string | null,
): number | null {
  if (targetCents === null || occasionDate === null) return null;
  const shortfall = targetCents - savedCents;
  if (shortfall <= 0) return null;
  const months = Math.max(1, Math.ceil(daysUntil(occasionDate) / 30.44));
  return Math.ceil(shortfall / months);
}

export default async function givingRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireAuth);

  /**
   * Actually given per fund over the last 12 months, keyed by category. Funds
   * without a category can't be measured against real transactions, so they
   * report 0 — the plan is all we know about them.
   */
  async function givenByCategory(categoryIds: string[]): Promise<Map<string, number>> {
    if (categoryIds.length === 0) return new Map();
    const cutoff = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const rows = await app.db
      .select({
        categoryId: transactions.categoryId,
        given: sql<string>`coalesce(sum(-${transactions.amountCents}) filter (where ${transactions.amountCents} < 0), 0)`,
      })
      .from(transactions)
      .where(
        and(
          gte(transactions.postedAt, cutoff),
          inArray(transactions.categoryId, categoryIds),
        ),
      )
      .groupBy(transactions.categoryId);
    return new Map(rows.map((r) => [r.categoryId!, Number(r.given)]));
  }

  async function toApi(
    row: typeof givingFunds.$inferSelect,
    given: Map<string, number>,
    balances: Map<string, number>,
  ): Promise<ApiGivingFund> {
    // A linked account's balance IS the money set aside — same rule savings
    // goals use, so "linked" means the same thing everywhere in the app.
    const savedCents =
      row.accountId && balances.has(row.accountId) ? balances.get(row.accountId)! : row.savedCents;
    return {
      id: row.id,
      name: row.name,
      kind: row.kind as GivingKind,
      recipient: row.recipient,
      monthlyCents: row.monthlyCents,
      savedCents,
      targetCents: row.targetCents,
      occasionDate: row.occasionDate,
      accountId: row.accountId,
      categoryId: row.categoryId,
      color: row.color,
      note: row.note,
      daysUntilOccasion: row.occasionDate ? daysUntil(row.occasionDate) : null,
      neededMonthlyCents: neededMonthly(row.targetCents, savedCents, row.occasionDate),
      givenThisYearCents: row.categoryId ? (given.get(row.categoryId) ?? 0) : 0,
    };
  }

  async function listAll(): Promise<ApiGivingFund[]> {
    const rows = await app.db.query.givingFunds.findMany({
      where: isNull(givingFunds.archivedAt),
      orderBy: [asc(givingFunds.kind), asc(givingFunds.name)],
    });
    const categoryIds = [...new Set(rows.map((r) => r.categoryId).filter((c): c is string => !!c))];
    const accountIds = [...new Set(rows.map((r) => r.accountId).filter((a): a is string => !!a))];
    const given = await givenByCategory(categoryIds);
    const balances = new Map<string, number>();
    if (accountIds.length > 0) {
      const accts = await app.db
        .select({ id: accounts.id, balanceCents: accounts.balanceCents })
        .from(accounts)
        .where(inArray(accounts.id, accountIds));
      for (const a of accts) balances.set(a.id, a.balanceCents);
    }
    return Promise.all(rows.map((r) => toApi(r, given, balances)));
  }

  async function one(id: string): Promise<ApiGivingFund> {
    const row = await app.db.query.givingFunds.findFirst({ where: eq(givingFunds.id, id) });
    if (!row) throw notFound("Giving fund");
    const given = await givenByCategory(row.categoryId ? [row.categoryId] : []);
    const balances = new Map<string, number>();
    if (row.accountId) {
      const acct = await app.db.query.accounts.findFirst({ where: eq(accounts.id, row.accountId) });
      if (acct) balances.set(acct.id, acct.balanceCents);
    }
    return toApi(row, given, balances);
  }

  app.get("/giving", async () => {
    const funds = await listAll();
    // Per fund, givenThisYearCents is "spending in this fund's category" — so
    // two funds pointed at the same category each report all of it. Summing
    // those would bill the household twice for money that left once, so the
    // total counts each category a single time.
    const countedCategories = new Set<string>();
    let givenThisYearCents = 0;
    for (const fund of funds) {
      if (!fund.categoryId || countedCategories.has(fund.categoryId)) continue;
      countedCategories.add(fund.categoryId);
      givenThisYearCents += fund.givenThisYearCents;
    }
    return {
      funds,
      monthlyGivingCents: funds
        .filter((f) => f.kind === "giving")
        .reduce((s, f) => s + f.monthlyCents, 0),
      monthlyGiftCents: funds
        .filter((f) => f.kind === "gift")
        .reduce((s, f) => s + f.monthlyCents, 0),
      totalSavedCents: funds.reduce((s, f) => s + f.savedCents, 0),
      givenThisYearCents,
    };
  });

  app.post("/giving", async (request, reply) => {
    const body = CreateGivingFundRequest.parse(request.body);
    const [row] = await app.db
      .insert(givingFunds)
      .values({
        name: body.name,
        kind: body.kind,
        recipient: body.recipient ?? null,
        monthlyCents: body.monthlyCents,
        savedCents: body.savedCents ?? 0,
        targetCents: body.targetCents ?? null,
        occasionDate: body.occasionDate ?? null,
        accountId: body.accountId ?? null,
        categoryId: body.categoryId ?? null,
        note: body.note ?? null,
        ...(body.color ? { color: body.color } : {}),
      })
      .returning();
    return reply.status(201).send(await one(row!.id));
  });

  app.patch<{ Params: { id: string } }>("/giving/:id", async (request) => {
    const body = UpdateGivingFundRequest.parse(request.body);
    const [row] = await app.db
      .update(givingFunds)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        ...(body.recipient !== undefined ? { recipient: body.recipient ?? null } : {}),
        ...(body.monthlyCents !== undefined ? { monthlyCents: body.monthlyCents } : {}),
        ...(body.savedCents !== undefined ? { savedCents: body.savedCents } : {}),
        ...(body.targetCents !== undefined ? { targetCents: body.targetCents ?? null } : {}),
        ...(body.occasionDate !== undefined ? { occasionDate: body.occasionDate ?? null } : {}),
        ...(body.accountId !== undefined ? { accountId: body.accountId ?? null } : {}),
        ...(body.categoryId !== undefined ? { categoryId: body.categoryId ?? null } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        ...(body.note !== undefined ? { note: body.note ?? null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(givingFunds.id, request.params.id))
      .returning();
    if (!row) throw notFound("Giving fund");
    return one(row.id);
  });

  // Add to (or subtract from) what a fund has set aside, mirroring bills.
  app.post<{ Params: { id: string } }>("/giving/:id/contribute", async (request) => {
    const { deltaCents } = ContributeGivingRequest.parse(request.body);
    const current = await app.db.query.givingFunds.findFirst({
      where: eq(givingFunds.id, request.params.id),
    });
    if (!current) throw notFound("Giving fund");
    await app.db
      .update(givingFunds)
      .set({ savedCents: Math.max(0, current.savedCents + deltaCents), updatedAt: new Date() })
      .where(eq(givingFunds.id, request.params.id));
    return one(request.params.id);
  });

  // Archive rather than delete, matching bills — the history a fund explains
  // (a year of donations to that charity) shouldn't vanish with the row.
  app.delete<{ Params: { id: string } }>("/giving/:id", async (request, reply) => {
    const [row] = await app.db
      .update(givingFunds)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(givingFunds.id, request.params.id), isNull(givingFunds.archivedAt)))
      .returning();
    if (!row) throw notFound("Giving fund");
    return reply.status(204).send();
  });
}
