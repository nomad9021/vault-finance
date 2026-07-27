import { type DebtPlan, UpdateDebtPlanRequest } from "@vault/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { debtPlan } from "../../db/schema.js";

const DEFAULTS: DebtPlan = {
  extraCents: 20000,
  strategy: "avalanche",
  overrides: {},
  manual: [],
};

function toApi(row: typeof debtPlan.$inferSelect): DebtPlan {
  return {
    extraCents: row.extraCents,
    strategy: row.strategy === "snowball" ? "snowball" : "avalanche",
    overrides: row.overrides ?? {},
    manual: row.manual ?? [],
  };
}

/**
 * The persisted "Get out of debt" planner state — a single shared record
 * (id = 1). The gear-window UI reads it on load and writes it on change, and
 * the cash-flow Sankey reads the same record so its debt branch matches.
 */
export default async function debtRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireAuth);

  app.get("/debt-plan", async (): Promise<DebtPlan> => {
    const row = await app.db.query.debtPlan.findFirst({ where: eq(debtPlan.id, 1) });
    return row ? toApi(row) : DEFAULTS;
  });

  app.put("/debt-plan", async (request): Promise<DebtPlan> => {
    const body = UpdateDebtPlanRequest.parse(request.body);
    // The jsonb column types differ from the zod-inferred ones only by
    // `exactOptionalPropertyTypes`' `| undefined`, so cast to the row shape.
    const row = {
      extraCents: body.extraCents,
      strategy: body.strategy,
      overrides: body.overrides as (typeof debtPlan.$inferInsert)["overrides"],
      manual: body.manual as (typeof debtPlan.$inferInsert)["manual"],
      updatedAt: new Date(),
    };
    await app.db
      .insert(debtPlan)
      .values({ id: 1, ...row })
      .onConflictDoUpdate({ target: debtPlan.id, set: row });
    return body;
  });
}
