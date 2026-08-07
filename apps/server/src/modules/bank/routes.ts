import type { BankConnection, BankStatus, BankSyncResponse } from "@vault/shared";
import { UpdateBankSettingsRequest } from "@vault/shared";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import { accounts, bankConnections, bankSettings, users } from "../../db/schema.js";
import { AppError, notFound } from "../../errors.js";
import { aiCategorizeUncategorized } from "../categorize/service.js";
import { isConfigured } from "./providers/index.js";
import { encryptSecret } from "../../secret-crypto.js";
import {
  loadBankSettings,
  providerConfig,
  syncConnection,
  type BankSettingsRow,
} from "./service.js";

async function connectionsFor(app: FastifyInstance): Promise<BankConnection[]> {
  const rows = await app.db.select().from(bankConnections).orderBy(bankConnections.createdAt);
  const counts = await app.db
    .select({
      connId: accounts.bankConnectionId,
      n: sql<number>`count(*)::int`,
    })
    .from(accounts)
    .groupBy(accounts.bankConnectionId);
  const byConn = new Map(counts.map((c) => [c.connId, c.n]));
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider as BankConnection["provider"],
    institutionName: r.institutionName,
    accountCount: byConn.get(r.id) ?? 0,
    createdAt: r.createdAt.toISOString(),
    lastSyncedAt: r.lastSyncedAt ? r.lastSyncedAt.toISOString() : null,
  }));
}

async function statusFor(app: FastifyInstance, settings: BankSettingsRow): Promise<BankStatus> {
  return {
    enabled: settings.enabled,
    provider: settings.provider,
    configured: isConfigured(providerConfig(settings)),
    hasPlaidCredentials: !!settings.plaidClientId && !!settings.plaidSecret,
    plaidEnv: settings.plaidEnv,
    connections: await connectionsFor(app),
  };
}

export default async function bankRoutes(
  app: FastifyInstance,
  opts: { config: AppConfig },
): Promise<void> {
  app.get(
    "/bank/status",
    { preHandler: [app.requireAuth] },
    async (): Promise<BankStatus> => {
      return statusFor(app, await loadBankSettings(app.db));
    },
  );

  // Plaid calls this (unauthenticated) when new data is ready — the real-time
  // push path. We only act on item_ids we already hold, so an unknown/forged
  // payload just no-ops. Production should additionally verify Plaid's JWT
  // (Plaid-Verification header); that's a hardening follow-up.
  app.post("/bank/webhook", async (request, reply) => {
    const body = (request.body ?? {}) as { item_id?: string };
    const itemId = body.item_id;
    if (itemId) {
      const [connection] = await app.db
        .select()
        .from(bankConnections)
        .where(eq(bankConnections.externalItemId, itemId))
        .limit(1);
      const settings = await loadBankSettings(app.db);
      const owner = await app.db.query.users.findFirst({ where: eq(users.role, "owner") });
      if (connection && settings.enabled && owner) {
        try {
          await syncConnection(
            app.db,
            providerConfig(settings, opts.config.plaidBaseUrl),
            connection,
            owner.id,
          );
          await aiCategorizeUncategorized(app, opts.config);
        } catch (err) {
          app.log.error({ err, itemId }, "webhook-triggered sync failed");
        }
      }
    }
    // Always 200 so Plaid doesn't retry-storm us.
    return reply.status(200).send({ received: true });
  });

  app.patch(
    "/bank/settings",
    { preHandler: [app.requireOwner] },
    async (request): Promise<BankStatus> => {
      const body = UpdateBankSettingsRequest.parse(request.body);
      await loadBankSettings(app.db); // ensure the row exists
      await app.db
        .update(bankSettings)
        .set({
          enabled: body.enabled,
          provider: body.provider,
          ...(body.plaidEnv ? { plaidEnv: body.plaidEnv } : {}),
          // Omitted key keeps the stored one; empty string clears it.
          ...(body.plaidClientId !== undefined
            ? { plaidClientId: body.plaidClientId.trim() || null }
            : {}),
          ...(body.plaidSecret !== undefined
            ? {
                plaidSecret: body.plaidSecret.trim()
                  ? encryptSecret(body.plaidSecret.trim())
                  : null,
              }
            : {}),
        })
        .where(eq(bankSettings.id, true));
      return statusFor(app, await loadBankSettings(app.db));
    },
  );

  app.post(
    "/bank/connect",
    { preHandler: [app.requireOwner] },
    async (request): Promise<BankSyncResponse> => {
      const settings = await loadBankSettings(app.db);
      if (!settings.enabled) {
        throw new AppError("BANK_DISABLED", 409, "Bank linking is turned off. Enable it first.");
      }
      const cfg = providerConfig(settings, opts.config.plaidBaseUrl);
      if (!isConfigured(cfg)) {
        throw new AppError("BANK_UNCONFIGURED", 400, "The selected provider isn't configured.");
      }
      const { getBankProvider } = await import("./providers/index.js");
      let result;
      try {
        result = await getBankProvider(cfg).connect();
      } catch (err) {
        throw new AppError("BANK_UNAVAILABLE", 502, `Couldn't reach the bank provider: ${String(err)}`);
      }
      const [connection] = await app.db
        .insert(bankConnections)
        .values({
          provider: settings.provider,
          externalItemId: result.externalItemId,
          accessToken: result.accessToken,
          institutionName: result.institutionName,
        })
        .returning();

      const outcome = await syncConnection(app.db, cfg, connection!, request.auth!.userId);
      return {
        connectionId: connection!.id,
        institutionName: connection!.institutionName,
        accountsLinked: outcome.accountsLinked,
        imported: outcome.imported,
        skippedDuplicates: outcome.skippedDuplicates,
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/bank/connections/:id/sync",
    { preHandler: [app.requireOwner] },
    async (request): Promise<BankSyncResponse> => {
      const settings = await loadBankSettings(app.db);
      const [connection] = await app.db
        .select()
        .from(bankConnections)
        .where(eq(bankConnections.id, request.params.id))
        .limit(1);
      if (!connection) throw notFound("Bank connection");
      const cfg = providerConfig(settings, opts.config.plaidBaseUrl);
      let outcome;
      try {
        outcome = await syncConnection(app.db, cfg, connection, request.auth!.userId);
      } catch (err) {
        throw new AppError("BANK_UNAVAILABLE", 502, `Sync failed: ${String(err)}`);
      }
      return {
        connectionId: connection.id,
        institutionName: connection.institutionName,
        accountsLinked: outcome.accountsLinked,
        imported: outcome.imported,
        skippedDuplicates: outcome.skippedDuplicates,
      };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/bank/connections/:id",
    { preHandler: [app.requireOwner] },
    async (request, reply) => {
      const [row] = await app.db
        .delete(bankConnections)
        .where(eq(bankConnections.id, request.params.id))
        .returning();
      if (!row) throw notFound("Bank connection");
      // Linked accounts survive (bank_connection_id set null via FK) so the
      // imported history the user now owns isn't lost on disconnect.
      return reply.status(204).send();
    },
  );
}
