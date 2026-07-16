import {
  CreateAccountRequest,
  LIABILITY_TYPES,
  UpdateAccountRequest,
  type Account as ApiAccount,
} from "@vault/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { accounts, transactions } from "../../db/schema.js";
import { notFound } from "../../errors.js";

function toApi(row: typeof accounts.$inferSelect): ApiAccount {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    institution: row.institution,
    mask: row.mask,
    currency: row.currency,
    isLiability: row.isLiability,
    interestRate: row.interestRate,
    balanceCents: row.balanceCents,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Household trust model: any authenticated member can manage all accounts
 * (this is a family finance app — the design shows one shared household).
 * ownerUserId records who created the account, nothing more.
 */
export default async function accountRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireAuth);

  app.get<{ Querystring: { archived?: string } }>("/accounts", async (request) => {
    const includeArchived = request.query.archived === "true";
    const rows = await app.db.query.accounts.findMany({
      ...(includeArchived ? {} : { where: isNull(accounts.archivedAt) }),
      orderBy: (t, { asc }) => [asc(t.createdAt)],
    });
    return { accounts: rows.map(toApi) };
  });

  app.post("/accounts", async (request, reply) => {
    const body = CreateAccountRequest.parse(request.body);
    const [row] = await app.db
      .insert(accounts)
      .values({
        ownerUserId: request.auth!.userId,
        name: body.name,
        type: body.type,
        institution: body.institution ?? null,
        mask: body.mask ?? null,
        isLiability: LIABILITY_TYPES.has(body.type),
        interestRate: body.interestRate ?? null,
        balanceCents: body.balanceCents,
      })
      .returning();
    return reply.status(201).send(toApi(row!));
  });

  app.get<{ Params: { id: string } }>("/accounts/:id", async (request) => {
    const row = await app.db.query.accounts.findFirst({
      where: eq(accounts.id, request.params.id),
    });
    if (!row) throw notFound("Account");
    return toApi(row);
  });

  app.patch<{ Params: { id: string } }>("/accounts/:id", async (request) => {
    const body = UpdateAccountRequest.parse(request.body);
    const [row] = await app.db
      .update(accounts)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.type !== undefined
          ? { type: body.type, isLiability: LIABILITY_TYPES.has(body.type) }
          : {}),
        ...(body.institution !== undefined ? { institution: body.institution } : {}),
        ...(body.mask !== undefined ? { mask: body.mask } : {}),
        ...(body.balanceCents !== undefined ? { balanceCents: body.balanceCents } : {}),
        ...(body.interestRate !== undefined ? { interestRate: body.interestRate } : {}),
        ...(body.archived !== undefined
          ? { archivedAt: body.archived ? new Date() : null }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, request.params.id))
      .returning();
    if (!row) throw notFound("Account");
    return toApi(row);
  });

  // Soft-delete (archive) when transactions exist; hard delete otherwise.
  app.delete<{ Params: { id: string } }>("/accounts/:id", async (request) => {
    const id = request.params.id;
    const existing = await app.db.query.accounts.findFirst({
      where: eq(accounts.id, id),
    });
    if (!existing) throw notFound("Account");

    const [{ count }] = (await app.db
      .select({ count: sql<number>`count(*)::int` })
      .from(transactions)
      .where(eq(transactions.accountId, id))) as [{ count: number }];

    if (count > 0) {
      await app.db
        .update(accounts)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(accounts.id, id), isNull(accounts.archivedAt)));
      return { archived: true };
    }
    await app.db.delete(accounts).where(eq(accounts.id, id));
    return { archived: false };
  });
}
