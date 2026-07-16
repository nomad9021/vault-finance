import {
  CreateTransactionRequest,
  TransactionListQuery,
  UpdateTransactionRequest,
  type ImportResponse,
  type Transaction as ApiTransaction,
} from "@vault/shared";
import { and, desc, eq, gte, isNull, lte, lt, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { accounts, categories, transactions } from "../../db/schema.js";
import { AppError, notFound } from "../../errors.js";
import { parseTransactionsCsv } from "./csv.js";

function toApi(row: typeof transactions.$inferSelect): ApiTransaction {
  return {
    id: row.id,
    accountId: row.accountId,
    categoryId: row.categoryId,
    postedAt: row.postedAt,
    amountCents: row.amountCents,
    currency: row.currency,
    merchantName: row.merchantName,
    description: row.description,
    pending: row.pending,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Cursor = base64url("postedAt|id") over (postedAt desc, id desc) ordering. */
function encodeCursor(postedAt: string, id: string): string {
  return Buffer.from(`${postedAt}|${id}`).toString("base64url");
}
function decodeCursor(cursor: string): { postedAt: string; id: string } | null {
  const decoded = Buffer.from(cursor, "base64url").toString();
  const sep = decoded.indexOf("|");
  if (sep === -1) return null;
  const postedAt = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(postedAt)) return null;
  return { postedAt, id };
}

const ImportRequest = z.object({
  accountId: z.string().uuid(),
  csv: z.string().min(1).max(5_000_000),
});

export default async function transactionRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireAuth);

  app.get("/transactions", async (request) => {
    const query = TransactionListQuery.parse(request.query);

    const filters: SQL[] = [];
    if (query.accountId) filters.push(eq(transactions.accountId, query.accountId));
    if (query.categoryId === "none") {
      filters.push(isNull(transactions.categoryId));
    } else if (query.categoryId) {
      filters.push(eq(transactions.categoryId, query.categoryId));
    }
    if (query.from) filters.push(gte(transactions.postedAt, query.from));
    if (query.to) filters.push(lte(transactions.postedAt, query.to));
    if (query.search) {
      // Prefix-match every term against the merchant-name FTS index, so
      // incremental typing ("star", "starbu") keeps matching.
      const terms = query.search
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => t.replace(/[':&|!()<>]/g, ""))
        .filter(Boolean);
      if (terms.length > 0) {
        const tsquery = terms.map((t) => `${t}:*`).join(" & ");
        filters.push(
          sql`to_tsvector('simple', ${transactions.merchantName}) @@ to_tsquery('simple', ${tsquery})`,
        );
      }
    }

    const whereBase = filters.length ? and(...filters) : undefined;

    const [{ count: totalCount }] = (await app.db
      .select({ count: sql<number>`count(*)::int` })
      .from(transactions)
      .where(whereBase)) as [{ count: number }];

    let whereWithCursor = whereBase;
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      if (c) {
        const cursorCond = or(
          lt(transactions.postedAt, c.postedAt),
          and(eq(transactions.postedAt, c.postedAt), lt(transactions.id, c.id)),
        )!;
        whereWithCursor = whereBase ? and(whereBase, cursorCond) : cursorCond;
      }
    }

    const rows = await app.db
      .select()
      .from(transactions)
      .where(whereWithCursor)
      .orderBy(desc(transactions.postedAt), desc(transactions.id))
      .limit(query.limit + 1);

    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      transactions: page.map(toApi),
      nextCursor:
        rows.length > query.limit && last ? encodeCursor(last.postedAt, last.id) : null,
      totalCount,
    };
  });

  app.post("/transactions", async (request, reply) => {
    const body = CreateTransactionRequest.parse(request.body);
    const account = await app.db.query.accounts.findFirst({
      where: eq(accounts.id, body.accountId),
    });
    if (!account) throw notFound("Account");

    const row = await app.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(transactions)
        .values({
          accountId: body.accountId,
          categoryId: body.categoryId ?? null,
          postedAt: body.postedAt,
          amountCents: body.amountCents,
          currency: account.currency,
          merchantName: body.merchantName,
          description: body.description ?? null,
          pending: body.pending,
          notes: body.notes ?? null,
        })
        .returning();
      // Account balance tracks its transactions; direct PATCHes on the
      // account remain available to correct drift (see accounts module).
      await tx
        .update(accounts)
        .set({
          balanceCents: sql`${accounts.balanceCents} + ${body.amountCents}`,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, body.accountId));
      return inserted!;
    });
    return reply.status(201).send(toApi(row));
  });

  app.get<{ Params: { id: string } }>("/transactions/:id", async (request) => {
    const row = await app.db.query.transactions.findFirst({
      where: eq(transactions.id, request.params.id),
    });
    if (!row) throw notFound("Transaction");
    return toApi(row);
  });

  app.patch<{ Params: { id: string } }>("/transactions/:id", async (request) => {
    const body = UpdateTransactionRequest.parse(request.body);
    const existing = await app.db.query.transactions.findFirst({
      where: eq(transactions.id, request.params.id),
    });
    if (!existing) throw notFound("Transaction");

    const row = await app.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(transactions)
        .set({
          ...(body.categoryId !== undefined ? { categoryId: body.categoryId } : {}),
          ...(body.postedAt !== undefined ? { postedAt: body.postedAt } : {}),
          ...(body.amountCents !== undefined ? { amountCents: body.amountCents } : {}),
          ...(body.merchantName !== undefined
            ? { merchantName: body.merchantName }
            : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.pending !== undefined ? { pending: body.pending } : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          updatedAt: new Date(),
        })
        .where(eq(transactions.id, request.params.id))
        .returning();
      if (body.amountCents !== undefined && body.amountCents !== existing.amountCents) {
        await tx
          .update(accounts)
          .set({
            balanceCents: sql`${accounts.balanceCents} + ${body.amountCents - existing.amountCents}`,
            updatedAt: new Date(),
          })
          .where(eq(accounts.id, existing.accountId));
      }
      return updated!;
    });
    return toApi(row);
  });

  app.delete<{ Params: { id: string } }>("/transactions/:id", async (request, reply) => {
    const existing = await app.db.query.transactions.findFirst({
      where: eq(transactions.id, request.params.id),
    });
    if (!existing) throw notFound("Transaction");
    await app.db.transaction(async (tx) => {
      await tx.delete(transactions).where(eq(transactions.id, existing.id));
      await tx
        .update(accounts)
        .set({
          balanceCents: sql`${accounts.balanceCents} - ${existing.amountCents}`,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, existing.accountId));
    });
    return reply.status(204).send();
  });

  app.post("/transactions/import", async (request, reply) => {
    const body = ImportRequest.parse(request.body);
    const account = await app.db.query.accounts.findFirst({
      where: eq(accounts.id, body.accountId),
    });
    if (!account) throw notFound("Account");

    const { rows, errors } = parseTransactionsCsv(body.csv);
    if (rows.length === 0 && errors.length > 0) {
      throw new AppError("VALIDATION_ERROR", 400, errors[0]!.message);
    }

    // Optional category column: match by name, case-insensitive.
    const allCategories = await app.db.query.categories.findMany();
    const byName = new Map(allCategories.map((c) => [c.name.toLowerCase(), c.id]));

    const result: ImportResponse = { imported: 0, skippedDuplicates: 0, errors };
    await app.db.transaction(async (tx) => {
      let balanceDelta = 0;
      for (const row of rows) {
        const inserted = await tx
          .insert(transactions)
          .values({
            accountId: body.accountId,
            categoryId: row.categoryName
              ? (byName.get(row.categoryName.toLowerCase()) ?? null)
              : null,
            postedAt: row.postedAt,
            amountCents: row.amountCents,
            currency: account.currency,
            merchantName: row.merchantName,
            description: row.description,
            externalId: row.externalId,
          })
          .onConflictDoNothing({
            // Must name the partial dedupe index's condition too, or Postgres
            // won't match ON CONFLICT to it.
            target: [transactions.accountId, transactions.externalId],
            where: sql`external_id is not null`,
          })
          .returning({ id: transactions.id });
        if (inserted.length > 0) {
          result.imported++;
          balanceDelta += row.amountCents;
        } else {
          result.skippedDuplicates++;
        }
      }
      if (balanceDelta !== 0) {
        await tx
          .update(accounts)
          .set({
            balanceCents: sql`${accounts.balanceCents} + ${balanceDelta}`,
            updatedAt: new Date(),
          })
          .where(eq(accounts.id, body.accountId));
      }
    });

    return reply.status(200).send(result);
  });
}
