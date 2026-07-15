import type { VersionResponse } from "@vault/shared";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";

export default async function metaRoutes(
  app: FastifyInstance,
  opts: { config: AppConfig },
) {
  app.get("/version", async (): Promise<VersionResponse> => {
    return {
      apiVersion: opts.config.apiVersion,
      minClientVersion: opts.config.minClientVersion,
    };
  });

  app.get("/health", async () => {
    await app.db.execute(sql`select 1`); // liveness includes the DB — a server that can't reach Postgres isn't healthy
    return { status: "ok" };
  });
}
