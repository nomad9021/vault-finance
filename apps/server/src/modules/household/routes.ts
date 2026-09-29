import { UpdateHouseholdRequest, type Household } from "@vault/shared";
import type { FastifyInstance } from "fastify";
import { META_KEYS, readMeta, writeMeta } from "../../lib/app-meta.js";

/**
 * The household's display name. Everyone on this server is already in one
 * household (see members/); this just gives it a name of its own. Any member
 * can read it, only the owner can rename it.
 */
export default async function householdRoutes(app: FastifyInstance) {
  app.get("/household", { preHandler: [app.requireAuth] }, async (): Promise<Household> => ({
    name: await readMeta(app.db, META_KEYS.householdName),
  }));

  app.patch("/household", { preHandler: [app.requireOwner] }, async (request): Promise<Household> => {
    const body = UpdateHouseholdRequest.parse(request.body);
    await writeMeta(app.db, META_KEYS.householdName, body.name);
    return { name: body.name };
  });
}
