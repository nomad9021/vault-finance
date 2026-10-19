import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp as buildApp } from "./helpers/test-app.js";
import { loadConfig } from "../src/config.js";
import { bankConnections, transactions } from "../src/db/schema.js";
import { isEncrypted } from "../src/secret-crypto.js";

/**
 * Real-bank linking through Plaid Hosted Link, against a fake Plaid that
 * follows the documented API: start a session → the person finishes in the
 * browser → poll → exchange → sync, then incremental syncs, a bank that wants
 * a fresh sign-in, reconnect, and disconnect.
 */
describe("Plaid Hosted Link", () => {
  const PG_PORT = 55492;
  let pg: EmbeddedPostgres;
  let app: FastifyInstance;
  let owner: { authorization: string };
  let plaid: Server;

  // ── fake Plaid state ──
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let sessionFinished = false;
  let updateModeFinished = false;
  let loginRequired = false;
  let mutateOnce = false;
  let phase = 1; // which transaction history the bank currently has

  const txn = (id: string, amount: number, name: string, pending = false) => ({
    transaction_id: id, account_id: "acc-chk", date: "2026-10-01", amount, name, merchant_name: name, pending,
  });

  beforeAll(async () => {
    plaid = createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      calls.push({ path: req.url!, body });
      res.setHeader("content-type", "application/json");
      const send = (o: unknown, status = 200) => {
        res.statusCode = status;
        res.end(JSON.stringify(o));
      };
      const err = (code: string) => send({ error_type: "ITEM_ERROR", error_code: code, error_message: code, display_message: null }, 400);
      if (body.client_id !== "client-1" || body.secret !== "secret-1") return send({ error_code: "INVALID_API_KEYS", error_message: "bad keys" }, 400);

      switch (req.url) {
        case "/link/token/create":
          return send({
            link_token: body.access_token ? "link-update" : "link-new",
            hosted_link_url: `https://hosted.plaid.com/link/${body.access_token ? "update" : "new"}`,
            expiration: new Date(Date.now() + 30 * 60_000).toISOString(),
          });
        case "/link/token/get": {
          if (body.link_token === "link-update") {
            return send({ link_sessions: updateModeFinished ? [{ finished_at: "now", results: { item_add_results: [] } }] : [] });
          }
          return send({
            link_sessions: sessionFinished
              ? [{ finished_at: "now", results: { item_add_results: [{ public_token: "public-1", institution: { name: "Real Bank" } }] } }]
              : [{ started_at: "now" }],
          });
        }
        case "/item/public_token/exchange":
          return send({ access_token: "access-production-1", item_id: "item-1" });
        case "/accounts/get":
          if (loginRequired) return err("ITEM_LOGIN_REQUIRED");
          return send({
            accounts: [{ account_id: "acc-chk", name: "Checking", mask: "1234", type: "depository", subtype: "checking",
              balances: { current: 500.25, available: 500.25, iso_currency_code: "USD" } }],
          });
        case "/transactions/sync": {
          if (mutateOnce) {
            mutateOnce = false;
            return err("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION");
          }
          const cursor = body.cursor as string | undefined;
          if (!cursor) return send({ added: [txn("t1", 12.5, "Coffee", true), txn("t2", 40, "Gas")], modified: [], removed: [], has_more: true, next_cursor: "c1" });
          if (cursor === "c1") return send({ added: [txn("t3", -2000, "Paycheck")], modified: [], removed: [], has_more: false, next_cursor: "c2" });
          if (cursor === "c2" && phase === 2) {
            return send({ added: [txn("t1-posted", 13, "Coffee")], modified: [txn("t2", 42, "Gas")], removed: [{ transaction_id: "t1" }], has_more: false, next_cursor: "c3" });
          }
          return send({ added: [], modified: [], removed: [], has_more: false, next_cursor: cursor });
        }
        case "/item/remove":
          return send({});
        default:
          return send({ error_code: "NOT_FOUND" }, 404);
      }
    });
    await new Promise<void>((r) => plaid.listen(0, "127.0.0.1", r));

    const pgDir = mkdtempSync(path.join(tmpdir(), "vault-plaid-pg-"));
    pg = new EmbeddedPostgres({ databaseDir: pgDir, user: "vault", password: "vault", port: PG_PORT, persistent: false });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("vault");
    app = await buildApp({
      config: loadConfig({
        DATABASE_URL: `postgres://vault:vault@localhost:${PG_PORT}/vault`,
        VAULT_TLS: "off",
        VAULT_DATA_DIR: mkdtempSync(path.join(tmpdir(), "vault-plaid-data-")),
        LOG_LEVEL: "error",
        UPDATE_CHECK_ENABLED: "false",
        PLAID_BASE_URL: `http://127.0.0.1:${(plaid.address() as AddressInfo).port}`,
      } as NodeJS.ProcessEnv),
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/setup/complete",
      payload: { ownerEmail: "sam@sam.home", ownerPassword: "correct-horse-battery", ownerDisplayName: "Sam" },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "sam@sam.home", password: "correct-horse-battery", deviceName: "T", platform: "linux" },
    });
    owner = { authorization: `Bearer ${login.json().accessToken}` };
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
    plaid?.close();
  });

  const req = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    app.inject({ method, url, headers: owner, ...(payload === undefined ? {} : { payload }) });
  let sessionId = "";
  let connectionId = "";

  it("starts a Hosted Link session for real banks", async () => {
    const saved = await req("PATCH", "/api/v1/bank/settings", {
      enabled: true, provider: "plaid", plaidEnv: "production", plaidClientId: "client-1", plaidSecret: "secret-1",
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ plaidEnv: "production", configured: true });

    const res = await req("POST", "/api/v1/bank/link", {});
    expect(res.statusCode).toBe(200);
    sessionId = res.json().sessionId;
    expect(res.json().url).toBe("https://hosted.plaid.com/link/new");
    const create = calls.find((c) => c.path === "/link/token/create")!.body;
    expect(create).toMatchObject({ products: ["transactions"], user: { client_user_id: expect.any(String) }, hosted_link: {} });
  });

  it("waits while the person is still signing in, then links the bank and imports everything", async () => {
    expect((await req("GET", `/api/v1/bank/link/${sessionId}`)).json()).toMatchObject({ status: "waiting" });

    sessionFinished = true;
    mutateOnce = true; // Plaid's data changes mid-sync once; the sync must restart cleanly.
    const done = (await req("GET", `/api/v1/bank/link/${sessionId}`)).json();
    expect(done).toMatchObject({ status: "connected", results: [{ institutionName: "Real Bank", accountsLinked: 1, imported: 3 }] });
    connectionId = done.results[0].connectionId;

    // Polling again returns the same result without exchanging the token twice.
    await req("GET", `/api/v1/bank/link/${sessionId}`);
    expect(calls.filter((c) => c.path === "/item/public_token/exchange")).toHaveLength(1);

    const row = await app.db.query.bankConnections.findFirst({ where: eq(bankConnections.id, connectionId) });
    expect(isEncrypted(row!.accessToken!)).toBe(true);
    expect(row!.syncCursor).toBe("c2");
  });

  it("syncs incrementally: posts pending charges, applies changes, removes what the bank removed", async () => {
    phase = 2;
    const res = await req("POST", `/api/v1/bank/connections/${connectionId}/sync`);
    expect(res.statusCode).toBe(200);
    expect(calls.filter((c) => c.path === "/transactions/sync").at(-1)!.body.cursor).toBe("c2");

    const rows = await app.db.select().from(transactions);
    const byId = Object.fromEntries(rows.map((t) => [t.externalId, t]));
    expect(byId["t1"]).toBeUndefined();
    expect(byId["t1-posted"]?.amountCents).toBe(-1300);
    expect(byId["t2"]?.amountCents).toBe(-4200);
    expect(byId["t3"]?.amountCents).toBe(200000);
  });

  it("flags a bank that wants a fresh sign-in, and reconnects it", async () => {
    loginRequired = true;
    const failed = await req("POST", `/api/v1/bank/connections/${connectionId}/sync`);
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error.message).toMatch(/sign in again/i);
    const status = (await req("GET", "/api/v1/bank/status")).json();
    expect(status.connections[0]).toMatchObject({ id: connectionId, needsReconnect: true });

    const start = (await req("POST", "/api/v1/bank/link", { connectionId })).json();
    expect(start.url).toBe("https://hosted.plaid.com/link/update");
    expect(calls.filter((c) => c.path === "/link/token/create").at(-1)!.body).toMatchObject({ access_token: "access-production-1" });

    loginRequired = false;
    updateModeFinished = true;
    const done = (await req("GET", `/api/v1/bank/link/${start.sessionId}`)).json();
    expect(done.status).toBe("reconnected");
    expect((await req("GET", "/api/v1/bank/status")).json().connections[0].needsReconnect).toBe(false);
  });

  it("explains rejected Plaid keys in plain words", async () => {
    await req("PATCH", "/api/v1/bank/settings", { enabled: true, provider: "plaid", plaidSecret: "wrong" });
    const res = await req("POST", "/api/v1/bank/link", {});
    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toMatch(/client ID or secret/);
    await req("PATCH", "/api/v1/bank/settings", { enabled: true, provider: "plaid", plaidSecret: "secret-1" });
  });

  it("tells Plaid to forget the bank on disconnect", async () => {
    const res = await req("DELETE", `/api/v1/bank/connections/${connectionId}`);
    expect(res.statusCode).toBe(204);
    expect(calls.at(-1)).toMatchObject({ path: "/item/remove", body: { access_token: "access-production-1" } });
  });

  it("no longer offers Plaid's retired Development environment", async () => {
    const res = await req("PATCH", "/api/v1/bank/settings", { enabled: true, provider: "plaid", plaidEnv: "development" });
    expect(res.statusCode).toBe(400);
  });
});
