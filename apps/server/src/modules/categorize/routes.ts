import type { AutocategorizeResponse, CategorizationRule, RuleListResponse } from "@vault/shared";
import { CreateRuleRequest } from "@vault/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import { categorizationRules } from "../../db/schema.js";
import { notFound } from "../../errors.js";
import { aiCategorizeUncategorized, sweepUncategorized } from "./service.js";

function toApi(row: typeof categorizationRules.$inferSelect): CategorizationRule {
  return {
    id: row.id,
    keyword: row.keyword,
    categoryId: row.categoryId,
    priority: row.priority,
  };
}

export default async function categorizeRoutes(
  app: FastifyInstance,
  opts: { config: AppConfig },
) {
  // Every route here reads or mutates shared household data (and
  // /transactions/autocategorize can invoke the AI provider), so the whole
  // module is authenticated — matching every other data module.
  app.addHook("preHandler", app.requireAuth);

  app.get("/categorization-rules", async (): Promise<RuleListResponse> => {
    const rows = await app.db
      .select()
      .from(categorizationRules)
      .orderBy(categorizationRules.priority, categorizationRules.keyword);
    return { rules: rows.map(toApi) };
  });

  app.post("/categorization-rules", async (request, reply) => {
    const body = CreateRuleRequest.parse(request.body);
    const [row] = await app.db
      .insert(categorizationRules)
      .values({
        keyword: body.keyword.trim(),
        categoryId: body.categoryId,
        priority: body.priority ?? 0,
      })
      .returning();
    return reply.status(201).send(toApi(row!));
  });

  app.delete<{ Params: { id: string } }>("/categorization-rules/:id", async (request, reply) => {
    const [row] = await app.db
      .delete(categorizationRules)
      .where(eq(categorizationRules.id, request.params.id))
      .returning();
    if (!row) throw notFound("Rule");
    return reply.status(204).send();
  });

  app.post("/transactions/autocategorize", async (): Promise<AutocategorizeResponse> => {
    // Rules + learned history first (instant, local), then the AI fallback for
    // whatever's left — which only does anything when AI is enabled.
    const swept = await sweepUncategorized(app.db);
    const byAi = await aiCategorizeUncategorized(app, opts.config);
    return {
      ...swept,
      categorized: swept.categorized + byAi,
      byAi,
    };
  });
}
