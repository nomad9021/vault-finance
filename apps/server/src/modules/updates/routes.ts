import type { UpdateStatusResponse } from "@vault/shared";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import { getUpdateStatus } from "./service.js";

export default async function updateRoutes(
  app: FastifyInstance,
  opts: { config: AppConfig },
) {
  // Any authenticated member can see whether the server is behind — the desktop
  // app renders a small banner from this. Acting on it is an operator task.
  app.get(
    "/updates/status",
    { preHandler: [app.requireAuth] },
    async (): Promise<UpdateStatusResponse> =>
      getUpdateStatus(app.db, opts.config, app.log),
  );
}
