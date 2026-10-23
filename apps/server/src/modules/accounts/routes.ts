import {
  CreateAccountRequest,
  LIABILITY_TYPES,
  UpdateAccountRequest,
  type Account as ApiAccount,
  type AccountSetAside,
} from "@vault/shared";
import { and, eq, isNull, isNotNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Db } from "../../plugins/db.js";
import { accounts, bills, givingFunds, savingsBuckets, transactions } from "../../db/schema.js";
import { notFound } from "../../errors.js";

/**
 * What each account's money is already set aside for. Bills and funds carry a
 * saved amount and an optional account; buckets split an account outright. A
 * fund linked to an account reports that account's whole balance as its
 * savings (see giving routes), so here it claims the whole positive balance.
 */
async function setAsideByAccount(db: Db): Promise<Map<string, AccountSetAside[]>> {
  const [billRows, fundRows, bucketRows, acctRows] = await Promise.all([
    db.select().from(bills).where(and(isNull(bills.archivedAt), isNotNull(bills.accountId))),
    db.select().from(givingFunds).where(and(isNull(givingFunds.archivedAt), isNotNull(givingFunds.accountId))),
    db.select().from(savingsBuckets),
    db.select({ id: accounts.id, balanceCents: accounts.balanceCents }).from(accounts),
  ]);
  const balance = new Map(acctRows.map((a) => [a.id, a.balanceCents]));
  const out = new Map<string, AccountSetAside[]>();
  const add = (accountId: string, item: AccountSetAside) => {
    if (item.cents <= 0) return;
    const list = out.get(accountId) ?? [];
    list.push(item);
    out.set(accountId, list);
  };
  for (const b of billRows) add(b.accountId!, { kind: "bill", id: b.id, name: b.name, cents: b.savedCents });
  const claimed = new Set<string>();
  for (const f of fundRows) {
    // Two funds on one account share it; count the balance once.
    if (claimed.has(f.accountId!)) continue;
    claimed.add(f.accountId!);
    add(f.accountId!, { kind: "fund", id: f.id, name: f.name, cents: balance.get(f.accountId!) ?? 0 });
  }
  for (const b of bucketRows) add(b.accountId, { kind: "bucket", id: b.id, name: b.name, cents: b.allocatedCents });
  return out;
}

function toApi(row: typeof accounts.$inferSelect, setAside: AccountSetAside[] = []): ApiAccount {
  const parts = row.isLiability ? [] : setAside;
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
    setAsideCents: parts.reduce((s, p) => s + p.cents, 0),
    setAside: parts,
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
    const setAside = await setAsideByAccount(app.db);
    return { accounts: rows.map((r) => toApi(r, setAside.get(r.id))) };
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
    return toApi(row, (await setAsideByAccount(app.db)).get(row.id));
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
