import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { encryptExistingSecrets } from "./db/encrypt-existing-secrets.js";
import { configureSecretCrypto } from "./secret-crypto.js";
import authPlugin from "./plugins/auth.js";
import dbPlugin from "./plugins/db.js";
import errorHandlerPlugin from "./plugins/error-handler.js";
import rateLimitPlugin from "./plugins/rate-limit.js";
import securityHeadersPlugin from "./plugins/security-headers.js";
import versionGatePlugin from "./plugins/version-gate.js";
import accountRoutes from "./modules/accounts/routes.js";
import aiRoutes from "./modules/ai/routes.js";
import authRoutes from "./modules/auth/routes.js";
import bankRoutes from "./modules/bank/routes.js";
import { startBankAutoSync } from "./modules/bank/scheduler.js";
import billRoutes from "./modules/bills/routes.js";
import budgetRoutes from "./modules/budgets/routes.js";
import cashflowRoutes from "./modules/cashflow/routes.js";
import categorizeRoutes from "./modules/categorize/routes.js";
import categoryRoutes from "./modules/categories/routes.js";
import debtRoutes from "./modules/debts/routes.js";
import givingRoutes from "./modules/giving/routes.js";
import goalRoutes from "./modules/goals/routes.js";
import insightRoutes from "./modules/insights/routes.js";
import investmentRoutes from "./modules/investments/routes.js";
import reportRoutes from "./modules/reports/routes.js";
import metaRoutes from "./modules/meta/routes.js";
import mobileRoutes from "./modules/mobile/routes.js";
import setupRoutes from "./modules/setup/routes.js";
import subscriptionRoutes from "./modules/subscriptions/routes.js";
import transactionRoutes from "./modules/transactions/routes.js";

/**
 * Same-origin and native callers send no Origin header and are always allowed.
 * Loopback origins keep browser-based development working. Anything else must
 * be named explicitly via VAULT_CORS_ORIGINS.
 */
function corsOrigin(allowList: string[]) {
  return (origin: string | undefined, cb: (err: Error | null, ok: boolean) => void) => {
    if (!origin) return cb(null, true);
    if (allowList.includes(origin)) return cb(null, true);
    let host: string;
    try {
      host = new URL(origin).hostname;
    } catch {
      return cb(null, false);
    }
    cb(null, host === "localhost" || host === "127.0.0.1" || host === "::1");
  };
}

export interface BuildAppOptions {
  config: AppConfig;
  /** Tests run migrations themselves against a throwaway DB. */
  runMigrations?: boolean;
  https?: { cert: string; key: string };
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  // Before anything can touch a secret column. Deliberately eager: a missing
  // key must fail at boot, never silently at the moment a secret is written.
  configureSecretCrypto(opts.config.dataDir, opts.config.dataKey);

  const app = Fastify({
    logger: { level: opts.config.logLevel },
    trustProxy: false,
    ...(opts.https ? { https: opts.https } : {}),
  });

  // Bearer auth means a hostile origin can't ride a session, but reflecting
  // every origin still let any page a household member visits read
  // `/auth/profiles` — unauthenticated, and it lists member names — and probe
  // for the server on their LAN. Native clients send no Origin at all (the
  // Tauri host proxies through Rust), so restricting this costs them nothing.
  await app.register(cors, { origin: corsOrigin(opts.config.corsOrigins) });
  await app.register(securityHeadersPlugin, { tls: Boolean(opts.https) });
  await app.register(errorHandlerPlugin);
  await app.register(rateLimitPlugin);
  await app.register(versionGatePlugin, {
    minClientVersion: opts.config.minClientVersion,
  });
  await app.register(dbPlugin, {
    databaseUrl: opts.config.databaseUrl,
    runMigrations: opts.runMigrations ?? true,
  });
  // Upgrades secrets written before column encryption existed. Idempotent, so
  // it's a no-op on every restart after the first.
  await encryptExistingSecrets(app.db, app.log);
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
      await api.register(categorizeRoutes, { config: opts.config });
      await api.register(bankRoutes, { config: opts.config });
      await api.register(budgetRoutes);
      await api.register(aiRoutes, { config: opts.config });
      await api.register(cashflowRoutes);
      await api.register(investmentRoutes);
      await api.register(goalRoutes);
      await api.register(billRoutes);
      await api.register(givingRoutes);
      await api.register(subscriptionRoutes);
      await api.register(insightRoutes);
      await api.register(debtRoutes);
      await api.register(reportRoutes, { config: opts.config });
    },
    { prefix: "/api/v1" },
  );

  // Read-only phone viewer at the site root (same origin as the API).
  await app.register(mobileRoutes);

  startBankAutoSync(app, opts.config);

  return app;
}
