import {
  ContributeBillRequest,
  CreateBillRequest,
  UpdateBillRequest,
  type Bill as ApiBill,
  type BillCadence,
} from "@vault/shared";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { bills } from "../../db/schema.js";
import { notFound } from "../../errors.js";
import { daysUntilDue, nextDueDate } from "./due.js";

function toApi(row: typeof bills.$inferSelect): ApiBill {
  const next = nextDueDate(row.dueDay);
  return {
    id: row.id,
    name: row.name,
    amountCents: row.amountCents,
    savedCents: row.savedCents,
    dueDay: row.dueDay,
    cadence: row.cadence as BillCadence,
    autopay: row.autopay,
    accountId: row.accountId,
    categoryId: row.categoryId,
    color: row.color,
    nextDueDate: next,
    daysUntilDue: daysUntilDue(row.dueDay),
  };
}

export default async function billRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireAuth);

  app.get("/bills", async () => {
    const rows = await app.db.query.bills.findMany({
      where: isNull(bills.archivedAt),
      orderBy: [asc(bills.dueDay), asc(bills.name)],
    });
    const list = rows.map(toApi).sort((a, b) => a.daysUntilDue - b.daysUntilDue);
    return {
      bills: list,
      totalDueCents: list.reduce((s, b) => s + b.amountCents, 0),
      totalSavedCents: list.reduce((s, b) => s + b.savedCents, 0),
    };
  });

  app.post("/bills", async (request, reply) => {
    const body = CreateBillRequest.parse(request.body);
    const [row] = await app.db
      .insert(bills)
      .values({
        name: body.name,
        amountCents: body.amountCents,
        savedCents: body.savedCents ?? 0,
        dueDay: body.dueDay,
        cadence: body.cadence,
        autopay: body.autopay ?? false,
        accountId: body.accountId ?? null,
        categoryId: body.categoryId ?? null,
        ...(body.color ? { color: body.color } : {}),
      })
      .returning();
    return reply.status(201).send(toApi(row!));
  });

  app.patch<{ Params: { id: string } }>("/bills/:id", async (request) => {
    const body = UpdateBillRequest.parse(request.body);
    const [row] = await app.db
      .update(bills)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.amountCents !== undefined ? { amountCents: body.amountCents } : {}),
        ...(body.savedCents !== undefined ? { savedCents: body.savedCents } : {}),
        ...(body.dueDay !== undefined ? { dueDay: body.dueDay } : {}),
        ...(body.cadence !== undefined ? { cadence: body.cadence } : {}),
        ...(body.autopay !== undefined ? { autopay: body.autopay } : {}),
        ...(body.accountId !== undefined ? { accountId: body.accountId ?? null } : {}),
        ...(body.categoryId !== undefined ? { categoryId: body.categoryId ?? null } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        updatedAt: new Date(),
      })
      .where(eq(bills.id, request.params.id))
      .returning();
    if (!row) throw notFound("Bill");
    return toApi(row);
  });

  // Add to (or subtract from) the amount set aside for a bill.
  app.post<{ Params: { id: string } }>("/bills/:id/contribute", async (request) => {
    const { deltaCents } = ContributeBillRequest.parse(request.body);
    const current = await app.db.query.bills.findFirst({ where: eq(bills.id, request.params.id) });
    if (!current) throw notFound("Bill");
    const [row] = await app.db
      .update(bills)
      .set({ savedCents: Math.max(0, current.savedCents + deltaCents), updatedAt: new Date() })
      .where(eq(bills.id, request.params.id))
      .returning();
    return toApi(row!);
  });

  app.delete<{ Params: { id: string } }>("/bills/:id", async (request, reply) => {
    const [row] = await app.db
      .update(bills)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(bills.id, request.params.id), isNull(bills.archivedAt)))
      .returning();
    if (!row) throw notFound("Bill");
    return reply.status(204).send();
  });
}
