import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import authPlugin from "./plugins/auth.js";
import dbPlugin from "./plugins/db.js";
import errorHandlerPlugin from "./plugins/error-handler.js";
import versionGatePlugin from "./plugins/version-gate.js";
import accountRoutes from "./modules/accounts/routes.js";
import authRoutes from "./modules/auth/routes.js";
import budgetRoutes from "./modules/budgets/routes.js";
import categoryRoutes from "./modules/categories/routes.js";
import metaRoutes from "./modules/meta/routes.js";
import setupRoutes from "./modules/setup/routes.js";
import transactionRoutes from "./modules/transactions/routes.js";

export interface BuildAppOptions {
  config: AppConfig;
  /** Tests run migrations themselves against a throwaway DB. */
  runMigrations?: boolean;
  https?: { cert: string; key: string };
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: opts.config.logLevel },
    trustProxy: false,
    ...(opts.https ? { https: opts.https } : {}),
  });

  // Reflective CORS is safe here: auth is bearer-token (no cookies), so a
  // hostile origin gains nothing — and the Tauri clients bypass CORS anyway.
  // This exists for browser-based dev of the frontend.
  await app.register(cors, { origin: true });
  await app.register(errorHandlerPlugin);
  await app.register(versionGatePlugin, {
    minClientVersion: opts.config.minClientVersion,
  });
  await app.register(dbPlugin, {
    databaseUrl: opts.config.databaseUrl,
    runMigrations: opts.runMigrations ?? true,
  });
  await app.register(authPlugin, {
    jwtSecret: opts.config.jwtSecret,
    accessTokenTtlSeconds: opts.config.accessTokenTtlSeconds,
  });

  await app.register(
    async (api) => {
      await api.register(metaRoutes, { config: opts.config });
      await api.register(setupRoutes, { config: opts.config });
      await api.register(authRoutes);
      await api.register(accountRoutes);
      await api.register(categoryRoutes);
      await api.register(transactionRoutes);
      await api.register(budgetRoutes);
    },
    { prefix: "/api/v1" },
  );

  return app;
}
