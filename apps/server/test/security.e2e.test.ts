import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

/**
 * Security regression suite. Locks in the fixes from the security audit so a
 * future refactor can't silently reopen them:
 *  - categorization endpoints require authentication (was: wide open);
 *  - CSV export neutralizes spreadsheet formula injection;
 *  - baseline security headers are present on API responses.
 */

const PG_PORT = 55450;

let pg: EmbeddedPostgres;
let app: FastifyInstance;
let dataDir: string;
let pgDir: string;
let auth: { authorization: string };
let accountId: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "vault-sec-data-"));
  pgDir = mkdtempSync(path.join(tmpdir(), "vault-sec-pg-"));

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
      ownerEmail: "owner@vault.home",
      ownerPassword: "correct-horse-battery",
      ownerDisplayName: "Owner",
    },
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: {
      email: "owner@vault.home",
      password: "correct-horse-battery",
      deviceName: "Test",
      platform: "linux",
    },
  });
  auth = { authorization: `Bearer ${login.json().accessToken}` };

  const account = await app.inject({
    method: "POST",
    url: "/api/v1/accounts",
    headers: auth,
    payload: { name: "Checking", type: "checking", balanceCents: 100_000 },
  });
  accountId = account.json().id;
});

afterAll(async () => {
  await app?.close();
  await pg?.stop();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(pgDir, { recursive: true, force: true });
});

describe("authorization: categorization endpoints require auth", () => {
  it("rejects unauthenticated reads of rules", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/categorization-rules" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects unauthenticated rule creation", async () => {
    const cats = await app.inject({ method: "GET", url: "/api/v1/categories", headers: auth });
    const categoryId = cats.json().categories[0].id;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/categorization-rules",
      payload: { keyword: "acme", categoryId },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects unauthenticated autocategorize (no forced AI/mutation)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/transactions/autocategorize" });
    expect(res.statusCode).toBe(401);
  });

  it("still works for an authenticated caller", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/transactions/autocategorize",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("input/output: CSV export formula injection", () => {
  it("prefixes formula-leading merchant names so spreadsheets treat them as text", async () => {
    // A transaction whose merchant name is a spreadsheet formula payload.
    await app.inject({
      method: "POST",
      url: "/api/v1/transactions",
      headers: auth,
      payload: {
        accountId,
        postedAt: "2024-01-15",
        amountCents: -1234,
        merchantName: "=HYPERLINK(\"http://evil.example\",\"click\")",
      },
    });

    const res = await app.inject({ method: "GET", url: "/api/v1/export/csv?type=transactions", headers: auth });
    expect(res.statusCode).toBe(200);
    // The dangerous "=" must be neutralized with a leading apostrophe, and the
    // raw "=HYPERLINK(" must never appear at the start of a field.
    expect(res.payload).toContain("'=HYPERLINK");
    expect(res.payload).not.toMatch(/(^|,)=HYPERLINK/m);
  });
});

describe("hardening: security headers", () => {
  it("sets baseline headers on API responses", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
  });
});

describe("authorization: data endpoints reject anonymous access", () => {
  it("returns 401 for /accounts without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/accounts" });
    expect(res.statusCode).toBe(401);
  });
});
