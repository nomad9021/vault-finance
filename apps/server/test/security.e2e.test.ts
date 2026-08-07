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

describe("hardening: secrets are encrypted at rest", () => {
  it("stores the TOTP secret as ciphertext, not the plaintext seed", async () => {
    const setup = await app.inject({
      method: "POST",
      url: "/api/v1/auth/2fa/setup",
      headers: auth,
    });
    expect(setup.statusCode).toBe(200);
    const plaintextSeed: string = setup.json().secret;
    expect(plaintextSeed).toBeTruthy();

    // Read the raw column — the API would hand back the decrypted value, which
    // would prove nothing about what actually sits on disk.
    const row = await app.db.query.users.findFirst({
      where: (t, { eq }) => eq(t.email, "owner@vault.home"),
    });
    expect(row?.totpSecret).toBeTruthy();
    expect(row!.totpSecret).toMatch(/^v1\./);
    // The thing a leaked pg_dump must not contain.
    expect(row!.totpSecret).not.toContain(plaintextSeed);
  });

  it("still verifies codes against the encrypted secret", async () => {
    // Round-trip through the real enable path: this only passes if the stored
    // ciphertext decrypts back to the seed the authenticator is using.
    const setup = await app.inject({
      method: "POST",
      url: "/api/v1/auth/2fa/setup",
      headers: auth,
    });
    const seed: string = setup.json().secret;
    const { currentTotpCode } = await import("../src/modules/auth/totp.js");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/2fa/enable",
      headers: auth,
      payload: { code: currentTotpCode(seed) },
    });
    expect(res.statusCode).toBe(204);
  });

  it("stores the AI API key as ciphertext", async () => {
    const key = "sk-test-do-not-store-me-in-the-clear";
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/settings",
      headers: auth,
      payload: {
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: key,
        enabled: false,
      },
    });
    expect(res.statusCode).toBeLessThan(400);

    const row = await app.db.query.aiSettings.findFirst();
    expect(row?.apiKey).toBeTruthy();
    expect(row!.apiKey).toMatch(/^v1\./);
    expect(row!.apiKey).not.toContain(key);
  });
});

describe("hardening: CORS is not reflective", () => {
  it("does not grant a hostile origin read access", async () => {
    // /auth/profiles is deliberately unauthenticated (the phone viewer needs
    // it before login) and lists household member names. Reflecting the origin
    // would let any page a member visits read that cross-origin.
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/profiles",
      headers: { origin: "https://evil.example" },
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("still allows loopback origins for browser-based development", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/profiles",
      headers: { origin: "http://localhost:5173" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("allows callers that send no Origin at all (native clients)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/profiles" });
    expect(res.statusCode).toBe(200);
  });
});
