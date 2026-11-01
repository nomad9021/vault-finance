import { createHash, randomBytes } from "node:crypto";
import type { BankConnection, BankLinkStartResponse, BankLinkStatus, BankStatus, BankSyncResponse } from "@vault/shared";
import { BankLinkStartRequest, UpdateBankSettingsRequest } from "@vault/shared";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import { accounts, bankConnections, bankSettings, users } from "../../db/schema.js";
import { AppError, notFound } from "../../errors.js";
import { aiCategorizeUncategorized } from "../categorize/service.js";
import { describePlaidError, getPlaid, isConfigured } from "./providers/index.js";
import { cachedKeyFetcher, verifyPlaidWebhook, type FetchKey } from "./webhook-verify.js";
import { decryptSecret, encryptSecret } from "../../secret-crypto.js";
import { META_KEYS, readMeta } from "../../lib/app-meta.js";
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
    needsReconnect: r.needsReconnect,
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

  // Plaid calls this when new data is ready — the real-time push path. It has
  // no session, so it must prove it's Plaid: the signed Plaid-Verification
  // JWT is checked against the exact body bytes (webhook-verify.ts). Only
  // then do we act, and only on item_ids we already hold.
  const webhookKeys = new Map<string, FetchKey>();
  await app.register(async (scope) => {
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

    scope.post("/bank/webhook", async (request, reply) => {
      const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const settings = await loadBankSettings(app.db);
      const cfg = providerConfig(settings, opts.config.plaidBaseUrl);
      if (!settings.enabled || settings.provider !== "plaid" || !isConfigured(cfg)) {
        return reply.status(401).send({ received: false });
      }
      // Keyed on the credentials too, so rotating the Plaid secret takes effect at once.
      const keysFor = createHash("sha256").update(`${cfg.plaidEnv}:${cfg.plaidClientId}:${cfg.plaidSecret}`).digest("hex");
      let fetchKey = webhookKeys.get(keysFor);
      if (!fetchKey) {
        fetchKey = cachedKeyFetcher((kid) => getPlaid(cfg).webhookVerificationKey(kid));
        webhookKeys.set(keysFor, fetchKey);
      }
      const header = request.headers["plaid-verification"];
      if (!(await verifyPlaidWebhook(raw, typeof header === "string" ? header : undefined, fetchKey))) {
        return reply.status(401).send({ received: false });
      }

      let body: { item_id?: unknown } = {};
      try {
        body = JSON.parse(raw.toString("utf8")) as typeof body;
      } catch {
        /* signed but not JSON — nothing to do */
      }
      const itemId = typeof body.item_id === "string" ? body.item_id : undefined;
      if (itemId) {
        const [connection] = await app.db
          .select()
          .from(bankConnections)
          .where(eq(bankConnections.externalItemId, itemId))
          .limit(1);
        const owner = await app.db.query.users.findFirst({ where: eq(users.role, "owner") });
        if (connection && owner) {
          try {
            await syncConnection(app.db, cfg, connection, owner.id);
            await aiCategorizeUncategorized(app, opts.config);
          } catch (err) {
            app.log.error({ err, itemId }, "webhook-triggered sync failed");
          }
        }
      }
      // Always 200 once verified so Plaid doesn't retry-storm us.
      return reply.status(200).send({ received: true });
    });
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
      if (settings.provider === "plaid") {
        throw new AppError("BANK_UNCONFIGURED", 400, "Plaid banks are linked through Plaid's sign-in page: use Link a bank.");
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
          // Bank access tokens can read every linked account — encrypted like the other secrets.
          accessToken: encryptSecret(result.accessToken),
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
        throw new AppError("BANK_UNAVAILABLE", 502, `Sync failed: ${describePlaidError(err)}`);
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
      // Ask Plaid to forget the item too, so it stops holding access to the
      // bank. Best effort: the local connection is already gone either way.
      if (row.provider === "plaid" && row.accessToken) {
        const settings = await loadBankSettings(app.db);
        try {
          await getPlaid(providerConfig(settings, opts.config.plaidBaseUrl)).removeItem(decryptSecret(row.accessToken)!);
        } catch (err) {
          request.log.warn({ err: describePlaidError(err) }, "couldn't remove the item at Plaid");
        }
      }
      // Linked accounts survive (bank_connection_id set null via FK) so the
      // imported history the user now owns isn't lost on disconnect.
      return reply.status(204).send();
    },
  );

  // ── Plaid Hosted Link ──
  // Sessions live in memory: they expire after 30 minutes anyway, and a
  // restart only means pressing "Link a bank" again.
  const linkSessions = new Map<
    string,
    {
      linkToken: string;
      connectionId?: string;
      userId: string;
      expiresAt: number;
      done?: BankLinkStatus;
      working?: Promise<BankLinkStatus> | undefined;
    }
  >();
  const forgetOldSessions = () => {
    const cutoff = Date.now() - 60 * 60_000;
    for (const [id, s] of linkSessions) if (s.expiresAt < cutoff) linkSessions.delete(id);
  };

  app.post("/bank/link", { preHandler: [app.requireOwner] }, async (request): Promise<BankLinkStartResponse> => {
    const body = BankLinkStartRequest.parse(request.body ?? {});
    const settings = await loadBankSettings(app.db);
    if (!settings.enabled) throw new AppError("BANK_DISABLED", 409, "Bank linking is turned off. Enable it first.");
    if (settings.provider !== "plaid") {
      throw new AppError("BANK_UNCONFIGURED", 400, "Linking real banks needs the Plaid provider.");
    }
    const cfg = providerConfig(settings, opts.config.plaidBaseUrl);
    if (!isConfigured(cfg)) throw new AppError("BANK_UNCONFIGURED", 400, "Add your Plaid client ID and secret first.");

    let accessToken: string | undefined;
    if (body.connectionId) {
      const [row] = await app.db.select().from(bankConnections).where(eq(bankConnections.id, body.connectionId)).limit(1);
      if (!row || row.provider !== "plaid" || !row.accessToken) throw notFound("Bank connection");
      accessToken = decryptSecret(row.accessToken)!;
    }
    const householdName = (await readMeta(app.db, META_KEYS.householdName)) || "Vault Finance";
    let session;
    try {
      session = await getPlaid(cfg).createLinkSession({
        clientUserId: request.auth!.userId,
        clientName: householdName,
        ...(accessToken ? { accessToken } : {}),
      });
    } catch (err) {
      throw new AppError("BANK_UNAVAILABLE", 502, describePlaidError(err));
    }
    forgetOldSessions();
    const sessionId = randomBytes(18).toString("base64url");
    linkSessions.set(sessionId, {
      linkToken: session.linkToken,
      ...(body.connectionId ? { connectionId: body.connectionId } : {}),
      userId: request.auth!.userId,
      expiresAt: Date.parse(session.expiresAt) || Date.now() + 30 * 60_000,
    });
    return { sessionId, url: session.url, expiresAt: session.expiresAt };
  });

  app.get<{ Params: { id: string } }>(
    "/bank/link/:id",
    { preHandler: [app.requireOwner] },
    async (request): Promise<BankLinkStatus> => {
      const s = linkSessions.get(request.params.id);
      if (!s || s.userId !== request.auth!.userId) {
        return { status: "expired", results: [], message: "That sign-in session has ended. Press Link a bank again." };
      }
      if (s.done) return s.done;
      // Two polls at once must not exchange the same token twice.
      s.working ??= finishLink(s).finally(() => {
        s.working = undefined;
      });
      const result = await s.working;
      if (result.status !== "waiting") s.done = result;
      return result;
    },
  );

  async function finishLink(s: { linkToken: string; connectionId?: string; userId: string; expiresAt: number }): Promise<BankLinkStatus> {
    const settings = await loadBankSettings(app.db);
    const cfg = providerConfig(settings, opts.config.plaidBaseUrl);
    const plaid = getPlaid(cfg);
    let session;
    try {
      session = await plaid.getLinkSession(s.linkToken);
    } catch (err) {
      return { status: "failed", results: [], message: describePlaidError(err) };
    }

    // Update mode: success means the bank accepted the new sign-in.
    if (s.connectionId) {
      if (!session.finished) {
        return Date.now() > s.expiresAt ? { status: "expired", results: [] } : { status: "waiting", results: [] };
      }
      if (session.exited) return { status: "exited", results: [], message: session.exitMessage ?? "Closed before reconnecting." };
      const [row] = await app.db.select().from(bankConnections).where(eq(bankConnections.id, s.connectionId)).limit(1);
      if (!row) return { status: "failed", results: [], message: "That connection was removed." };
      await app.db.update(bankConnections).set({ needsReconnect: false }).where(eq(bankConnections.id, row.id));
      const results: BankSyncResponse[] = [];
      try {
        const o = await syncConnection(app.db, cfg, { ...row, needsReconnect: false }, s.userId);
        results.push({ connectionId: row.id, institutionName: row.institutionName, ...o });
      } catch (err) {
        return { status: "failed", results, message: describePlaidError(err) };
      }
      return { status: "reconnected", results };
    }

    if (session.publicTokens.length === 0) {
      if (session.finished && session.exited) {
        return { status: "exited", results: [], message: session.exitMessage ?? "Closed without connecting a bank." };
      }
      return Date.now() > s.expiresAt ? { status: "expired", results: [] } : { status: "waiting", results: [] };
    }

    const results: BankSyncResponse[] = [];
    const problems: string[] = [];
    for (const t of session.publicTokens) {
      try {
        const { itemId, accessToken } = await plaid.exchange(t.publicToken);
        const institutionName = t.institutionName ?? (await plaid.institutionName(accessToken)) ?? "Bank";
        // Linking the same bank login again replaces the old token instead of duplicating it.
        const [existing] = await app.db
          .select()
          .from(bankConnections)
          .where(eq(bankConnections.externalItemId, itemId))
          .limit(1);
        const [connection] = existing
          ? await app.db
              .update(bankConnections)
              .set({ accessToken: encryptSecret(accessToken), needsReconnect: false, institutionName })
              .where(eq(bankConnections.id, existing.id))
              .returning()
          : await app.db
              .insert(bankConnections)
              .values({
                provider: "plaid",
                externalItemId: itemId,
                accessToken: encryptSecret(accessToken),
                institutionName,
              })
              .returning();
        const o = await syncConnection(app.db, cfg, connection!, s.userId);
        results.push({ connectionId: connection!.id, institutionName, ...o });
      } catch (err) {
        problems.push(describePlaidError(err));
      }
    }
    void aiCategorizeUncategorized(app, opts.config).catch(() => {});
    if (results.length === 0) return { status: "failed", results, message: problems.join(" ") };
    return { status: "connected", results, ...(problems.length ? { message: problems.join(" ") } : {}) };
  }
}
