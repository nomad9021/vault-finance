import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

/** Phase 2: optional bank linking, exercised through the local mock provider. */

describe("bank linking (mock provider)", () => {
  const PG_PORT = 55441;
  let pg: EmbeddedPostgres;
  let app: FastifyInstance;
  let dataDir: string;
  let pgDir: string;
  let auth: { authorization: string };

  const req = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as "GET", url, headers: auth, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "vault-m8-data-"));
    pgDir = mkdtempSync(path.join(tmpdir(), "vault-m8-pg-"));
    pg = new EmbeddedPostgres({
      databaseDir: pgDir,
      user: "vault",
      password: "vault",
      port: PG_PORT,
      persistent: false,
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("vault");

    app = await buildApp({
      config: loadConfig({
        DATABASE_URL: `postgres://vault:vault@localhost:${PG_PORT}/vault`,
        VAULT_TLS: "off",
        VAULT_DATA_DIR: dataDir,
        LOG_LEVEL: "error",
      } as NodeJS.ProcessEnv),
    });

    await app.inject({
      method: "POST",
      url: "/api/v1/setup/complete",
      payload: {
        ownerEmail: "kai@kai.home",
        ownerPassword: "correct-horse-battery",
        ownerDisplayName: "Kai",
      },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "kai@kai.home", password: "correct-horse-battery", deviceName: "T", platform: "linux" },
    });
    auth = { authorization: `Bearer ${login.json().accessToken}` };
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(pgDir, { recursive: true, force: true });
  });

  it("is off by default and refuses to connect until enabled", async () => {
    const status = await req("GET", "/api/v1/bank/status");
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ enabled: false, provider: "mock", connections: [] });

    const blocked = await req("POST", "/api/v1/bank/connect");
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("BANK_DISABLED");
  });

  it("connects a sandbox bank, creating accounts and importing transactions", async () => {
    const enabled = await req("PATCH", "/api/v1/bank/settings", { enabled: true, provider: "mock" });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ enabled: true, configured: true });

    const res = await req("POST", "/api/v1/bank/connect");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accountsLinked).toBe(3);
    expect(body.imported).toBe(80); // 8 weeks × 10 merchants
    expect(body.skippedDuplicates).toBe(0);

    // The accounts now exist and are tied to the connection.
    const accts = await req("GET", "/api/v1/accounts");
    const names = accts.json().accounts.map((a: { name: string }) => a.name);
    expect(names).toEqual(
      expect.arrayContaining(["Sandbox Checking", "Sandbox Savings", "Sandbox Credit Card"]),
    );

    const status = await req("GET", "/api/v1/bank/status");
    expect(status.json().connections).toHaveLength(1);
    expect(status.json().connections[0]).toMatchObject({ accountCount: 3, provider: "mock" });
    expect(status.json().connections[0].lastSyncedAt).not.toBeNull();
  });

  it("re-syncing is idempotent (dedupes on external id)", async () => {
    const status = await req("GET", "/api/v1/bank/status");
    const connId = status.json().connections[0].id;

    const resync = await req("POST", `/api/v1/bank/connections/${connId}/sync`);
    expect(resync.statusCode).toBe(200);
    expect(resync.json()).toMatchObject({ imported: 0, skippedDuplicates: 80 });
  });

  it("disconnecting keeps the imported accounts but drops the connection", async () => {
    const before = await req("GET", "/api/v1/bank/status");
    const connId = before.json().connections[0].id;

    const del = await req("DELETE", `/api/v1/bank/connections/${connId}`);
    expect(del.statusCode).toBe(204);

    const after = await req("GET", "/api/v1/bank/status");
    expect(after.json().connections).toHaveLength(0);
    // Accounts (and their history) survive the disconnect.
    const accts = await req("GET", "/api/v1/accounts");
    expect(accts.json().accounts.length).toBeGreaterThanOrEqual(3);
  });

  it("accepts Plaid webhooks unauthenticated and no-ops on unknown items", async () => {
    // No auth header — Plaid calls this endpoint from the outside.
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/bank/webhook",
      payload: {
        webhook_type: "TRANSACTIONS",
        webhook_code: "SYNC_UPDATES_AVAILABLE",
        item_id: "nonexistent-item",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true });
  });
});
