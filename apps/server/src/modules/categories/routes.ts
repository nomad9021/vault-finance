import {
  CreateCategoryRequest,
  MoveCategoryRequest,
  UpdateCategoryRequest,
  type Category as ApiCategory,
} from "@vault/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { budgets, categories, transactions } from "../../db/schema.js";
import { AppError, notFound } from "../../errors.js";

function toApi(row: typeof categories.$inferSelect): ApiCategory {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    color: row.color,
    parentCategoryId: row.parentCategoryId,
    sortOrder: row.sortOrder,
    kind: row.kind === "income" ? "income" : "expense",
    isSystem: row.isSystem,
  };
}

/**
 * Siblings for ordering purposes are same-parent AND same-kind, so income
 * sources and expense categories keep independent 0…n sequences even when both
 * sit at the top level.
 */
function sameSiblings(parentId: string | null, kind: string) {
  return and(
    parentId === null
      ? isNull(categories.parentCategoryId)
      : eq(categories.parentCategoryId, parentId),
    eq(categories.kind, kind),
  );
}

export default async function categoryRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireAuth);

  app.get("/categories", async () => {
    const rows = await app.db.query.categories.findMany({
      orderBy: (t, { asc }) => [asc(t.sortOrder), asc(t.name)],
    });
    return { categories: rows.map(toApi) };
  });

  app.post("/categories", async (request, reply) => {
    const body = CreateCategoryRequest.parse(request.body);
    const parentId = body.parentCategoryId ?? null;
    const kind = body.kind ?? "expense";
    // Append to the end of its sibling list.
    const [{ next } = { next: 0 }] = await app.db
      .select({ next: sql<number>`coalesce(max(${categories.sortOrder}), -1) + 1` })
      .from(categories)
      .where(sameSiblings(parentId, kind));
    const [row] = await app.db
      .insert(categories)
      .values({
        name: body.name,
        icon: body.icon ?? null,
        color: body.color,
        parentCategoryId: parentId,
        sortOrder: next,
        kind,
        isSystem: false,
      })
      .returning();
    return reply.status(201).send(toApi(row!));
  });

  // Swap a category with its adjacent sibling in the given direction. Siblings
  // are ordered by (sortOrder, name); moving swaps the two rows' sortOrder so
  // the change survives reload and drives the tree editor's order.
  app.post<{ Params: { id: string } }>("/categories/:id/move", async (request) => {
    const { direction } = MoveCategoryRequest.parse(request.body);
    const current = await app.db.query.categories.findFirst({
      where: eq(categories.id, request.params.id),
    });
    if (!current) throw notFound("Category");

    const siblings = await app.db.query.categories.findMany({
      where: sameSiblings(current.parentCategoryId, current.kind),
      orderBy: (t, { asc }) => [asc(t.sortOrder), asc(t.name)],
    });
    const idx = siblings.findIndex((s) => s.id === current.id);
    const neighbor = direction === "up" ? siblings[idx - 1] : siblings[idx + 1];
    if (neighbor) {
      // Two-row swap in a transaction; if orders happen to be equal (legacy
      // rows), nudge to keep them distinct.
      const a = current.sortOrder;
      const b = neighbor.sortOrder;
      const [ca, cb] = a === b ? (direction === "up" ? [b - 1, b] : [b + 1, b]) : [b, a];
      await app.db.transaction(async (tx) => {
        await tx.update(categories).set({ sortOrder: ca }).where(eq(categories.id, current.id));
        await tx.update(categories).set({ sortOrder: cb }).where(eq(categories.id, neighbor.id));
      });
    }

    const rows = await app.db.query.categories.findMany({
      orderBy: (t, { asc }) => [asc(t.sortOrder), asc(t.name)],
    });
    return { categories: rows.map(toApi) };
  });

  app.patch<{ Params: { id: string } }>("/categories/:id", async (request) => {
    const body = UpdateCategoryRequest.parse(request.body);
    const [row] = await app.db
      .update(categories)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.icon !== undefined ? { icon: body.icon } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        ...(body.parentCategoryId !== undefined
          ? { parentCategoryId: body.parentCategoryId }
          : {}),
      })
      .where(eq(categories.id, request.params.id))
      .returning();
    if (!row) throw notFound("Category");
    return toApi(row);
  });

  app.delete<{ Params: { id: string } }>("/categories/:id", async (request, reply) => {
    const id = request.params.id;
    const row = await app.db.query.categories.findFirst({
      where: eq(categories.id, id),
    });
    if (!row) throw notFound("Category");

    const inUse = row.isSystem
      ? true
      : await (async () => {
          const [txn] = await app.db
            .select({ count: sql<number>`count(*)::int` })
            .from(transactions)
            .where(eq(transactions.categoryId, id));
          if ((txn?.count ?? 0) > 0) return true;
          const [bud] = await app.db
            .select({ count: sql<number>`count(*)::int` })
            .from(budgets)
            .where(eq(budgets.categoryId, id));
          return (bud?.count ?? 0) > 0;
        })();

    if (inUse) {
      throw new AppError(
        "CATEGORY_IN_USE",
        409,
        row.isSystem
          ? "Built-in categories can't be deleted."
          : "This category has transactions or budgets. Reassign them first.",
      );
    }
    await app.db.delete(categories).where(eq(categories.id, id));
    return reply.status(204).send();
  });
}
