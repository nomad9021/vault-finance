import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp as buildApp, TEST_DEVICE } from "./helpers/test-app.js";
import { redactUrl } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { bankConnections, deviceSessions, memberInvites, users } from "../src/db/schema.js";
import { encryptExistingSecrets } from "../src/db/encrypt-existing-secrets.js";
import { purgeExpiredRecords } from "../src/lib/retention.js";
import { LOCKOUT_THRESHOLD } from "../src/modules/auth/service.js";
import { rotateDataKey } from "../src/rotate.js";
import { configureSecretCrypto, configureSecretCryptoWithKey, decryptSecret, isEncrypted } from "../src/secret-crypto.js";

/** The controls added in the October 2026 security audit. */
describe("security controls", () => {
  const PG_PORT = 55491;
  const PASSWORD = "correct-horse-battery";
  let pg: EmbeddedPostgres;
  let app: FastifyInstance;
  let dataDir: string;
  let owner: { authorization: string };
  let ip = 1;

  const login = (password: string, from = `10.9.0.${ip++}`) =>
    app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress: from,
      payload: { email: "sam@sam.home", password, deviceName: "T", platform: "linux", ...TEST_DEVICE },
    });

  beforeAll(async () => {
    const pgDir = mkdtempSync(path.join(tmpdir(), "vault-sec-pg-"));
    pg = new EmbeddedPostgres({ databaseDir: pgDir, user: "vault", password: "vault", port: PG_PORT, persistent: false });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("vault");
    dataDir = mkdtempSync(path.join(tmpdir(), "vault-sec-data-"));
    app = await buildApp({
      config: loadConfig({
        DATABASE_URL: `postgres://vault:vault@localhost:${PG_PORT}/vault`,
        VAULT_TLS: "off",
        VAULT_DATA_DIR: dataDir,
        LOG_LEVEL: "error",
        UPDATE_CHECK_ENABLED: "false",
      } as NodeJS.ProcessEnv),
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/setup/complete",
      payload: { ownerEmail: "sam@sam.home", ownerPassword: PASSWORD, ownerDisplayName: "Sam" },
    });
    owner = { authorization: `Bearer ${(await login(PASSWORD)).json().accessToken}` };
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  it("refuses weak new passwords", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/members",
      headers: owner,
      payload: { email: "kid@sam.home", displayName: "Kid", tempPassword: "password1234", role: "member" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/too common/i);
  });

  it("locks the account after repeated failures, from any IP address", async () => {
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      expect((await login("wrong-password-entirely")).statusCode).toBe(401);
    }
    // Even the right password is refused while locked.
    const locked = await login(PASSWORD);
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.message).toMatch(/locked/i);

    await app.db.update(users).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(users.email, "sam@sam.home"));
    expect((await login(PASSWORD)).statusCode).toBe(200);
    const row = await app.db.query.users.findFirst({ where: eq(users.email, "sam@sam.home") });
    expect(row?.failedLoginCount).toBe(0);
  });

  it("refuses an AI server on the internet over plain http", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/settings",
      headers: owner,
      payload: { enabled: true, provider: "local_openai", model: "m", baseUrl: "http://ai.example.com/v1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/https/);
    const lan = await app.inject({
      method: "POST",
      url: "/api/v1/ai/settings",
      headers: owner,
      payload: { enabled: false, provider: "local_openai", model: "m", baseUrl: "http://192.168.1.50:8080/v1" },
    });
    expect(lan.statusCode).toBe(200);
  });

  it("encrypts bank access tokens stored before encryption covered them", async () => {
    const [row] = await app.db
      .insert(bankConnections)
      .values({ provider: "plaid", externalItemId: "item-1", accessToken: "access-sandbox-plain", institutionName: "Test Bank" })
      .returning();
    await encryptExistingSecrets(app.db, app.log);
    const after = await app.db.query.bankConnections.findFirst({ where: eq(bankConnections.id, row!.id) });
    expect(isEncrypted(after!.accessToken!)).toBe(true);
    expect(decryptSecret(after!.accessToken)).toBe("access-sandbox-plain");
  });

  it("ends sign-ins that have sat unused for 30 days", async () => {
    const res = await login(PASSWORD);
    const { refreshToken } = res.json();
    const sessionId = refreshToken.split(".")[0];
    await app.db
      .update(deviceSessions)
      .set({ lastUsedAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(eq(deviceSessions.id, sessionId));
    const refreshed = await app.inject({ method: "POST", url: "/api/v1/auth/refresh", payload: { refreshToken, ...TEST_DEVICE } });
    expect(refreshed.statusCode).toBe(401);
    expect(refreshed.json().error.code).toBe("SESSION_REVOKED");
  });

  it("deletes sign-in records once they're no longer needed", async () => {
    const owner_ = await app.db.query.users.findFirst({ where: eq(users.email, "sam@sam.home") });
    const old = new Date(Date.now() - 90 * 86_400_000);
    await app.db.insert(memberInvites).values({
      tokenHash: "x".repeat(64),
      email: "old@sam.home",
      displayName: "Old",
      role: "member",
      invitedByUserId: owner_!.id,
      expiresAt: old,
    });
    await app.db.update(deviceSessions).set({ revokedAt: old });
    const n = await purgeExpiredRecords(app);
    expect(n.invites).toBeGreaterThanOrEqual(1);
    expect(n.sessions).toBeGreaterThanOrEqual(1);
  });

  it("rotates the data key and keeps every secret readable", async () => {
    const before = readFileSync(path.join(dataDir, "data-key"), "utf8");
    const r = await rotateDataKey(app.db, dataDir, undefined);
    expect(r.rotated).toBeGreaterThanOrEqual(1);
    const after = readFileSync(path.join(dataDir, "data-key"), "utf8");
    expect(after).not.toBe(before);

    configureSecretCryptoWithKey(Buffer.from(after, "base64"));
    const row = await app.db.query.bankConnections.findFirst();
    expect(decryptSecret(row!.accessToken)).toBe("access-sandbox-plain");
    // The server re-reads the key file on its next start.
    configureSecretCrypto(dataDir);
  });

  it("keeps invite tokens out of request logs", () => {
    expect(redactUrl("/api/v1/members/invite/abc123secret/accept")).toBe("/api/v1/members/invite/[redacted]/accept");
    expect(redactUrl("/api/v1/accounts?x=1")).toBe("/api/v1/accounts?x=1");
  });
});
