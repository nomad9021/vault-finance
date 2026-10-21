import {
  estimateTaxes,
  LOCALITIES_2026,
  STATES_2026,
  TAX_YEAR,
  TaxProfile,
  type TaxEstimate,
} from "@vault/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { budgetPlan, taxProfile } from "../../db/schema.js";
import { AppError } from "../../errors.js";

/**
 * Salary and taxes: the household's tax profile, its take-home estimate,
 * what-if estimates for other salaries or places, and the places we know.
 * Saving the profile keeps the budget planner's monthly income on the
 * estimated take-home when syncPlannedIncome is on.
 */

function estimate(profile: TaxProfile): TaxEstimate {
  try {
    return estimateTaxes(profile);
  } catch (err) {
    throw new AppError("VALIDATION_ERROR", 400, err instanceof Error ? err.message : String(err));
  }
}

export async function loadTaxProfile(app: FastifyInstance): Promise<TaxProfile | null> {
  const row = await app.db.query.taxProfile.findFirst({ where: eq(taxProfile.id, 1) });
  return row?.profile ?? null;
}

export default async function taxRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireAuth);

  app.get("/tax-profile", async () => {
    const profile = await loadTaxProfile(app);
    return { year: TAX_YEAR, profile, estimate: profile && profile.earners.length ? estimate(profile) : null };
  });

  app.put("/tax-profile", async (request) => {
    const profile = TaxProfile.parse(request.body);
    const est = profile.earners.length ? estimate(profile) : null;
    await app.db.transaction(async (tx) => {
      await tx
        .insert(taxProfile)
        .values({ id: 1, profile, updatedAt: new Date() })
        .onConflictDoUpdate({ target: taxProfile.id, set: { profile, updatedAt: new Date() } });
      if (est && profile.syncPlannedIncome) {
        const monthly = Math.round(est.takeHomeCents / 12);
        await tx
          .insert(budgetPlan)
          .values({ id: 1, plannedIncomeCents: monthly, updatedAt: new Date() })
          .onConflictDoUpdate({ target: budgetPlan.id, set: { plannedIncomeCents: monthly, updatedAt: new Date() } });
      }
    });
    return { year: TAX_YEAR, profile, estimate: est };
  });

  // What-if: any profile, nothing saved.
  app.post("/tax/estimate", async (request) => estimate(TaxProfile.parse(request.body)));

  app.get("/tax/places", async () => ({
    year: TAX_YEAR,
    states: Object.entries(STATES_2026).map(([code, s]) => ({ code, name: s.name, taxesWages: s.single.length > 0 })),
    localities: LOCALITIES_2026.map((l) => ({ id: l.id, state: l.state, name: l.name, verified: l.verified })),
  }));
}
