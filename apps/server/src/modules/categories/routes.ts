import {
  CreateCategoryRequest,
  UpdateCategoryRequest,
  type Category as ApiCategory,
} from "@vault/shared";
import { eq, sql } from "drizzle-orm";
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
    isSystem: row.isSystem,
  };
}

export default async function categoryRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireAuth);

  app.get("/categories", async () => {
    const rows = await app.db.query.categories.findMany({
      orderBy: (t, { asc }) => [asc(t.name)],
    });
    return { categories: rows.map(toApi) };
  });

  app.post("/categories", async (request, reply) => {
    const body = CreateCategoryRequest.parse(request.body);
    const [row] = await app.db
      .insert(categories)
      .values({
        name: body.name,
        icon: body.icon ?? null,
        color: body.color,
        parentCategoryId: body.parentCategoryId ?? null,
        isSystem: false,
      })
      .returning();
    return reply.status(201).send(toApi(row!));
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
