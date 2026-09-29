import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

/**
 * Biometric sign-in (device keys) and the household name. The biometric check
 * itself happens on the device; the server's job is issuing, honouring and
 * revoking the per-device key it unlocks.
 */
describe("device keys + household name", () => {
  const PG_PORT = 55471;
  let pg: EmbeddedPostgres;
  let app: FastifyInstance;
  let dataDir: string;
  let pgDir: string;
  let ownerAuth: { authorization: string };
  let memberAuth: { authorization: string };

  const login = async (email: string, password: string) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password, deviceName: "test", platform: "linux" },
    });
    return { authorization: `Bearer ${res.json().accessToken}` };
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "vault-dk-data-"));
    pgDir = mkdtempSync(path.join(tmpdir(), "vault-dk-pg-"));
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
        UPDATE_CHECK_ENABLED: "false",
      } as NodeJS.ProcessEnv),
    });
    app.mailer.send = async () => {};

    const setup = await app.inject({
      method: "POST",
      url: "/api/v1/setup/complete",
      payload: {
        ownerEmail: "owner@vault.test",
        ownerPassword: "correct-horse-battery",
        ownerDisplayName: "Pat Carter",
        householdName: "The Carters",
      },
    });
    expect(setup.statusCode).toBe(201);
    ownerAuth = await login("owner@vault.test", "correct-horse-battery");

    await app.inject({
      method: "POST",
      url: "/api/v1/members",
      headers: ownerAuth,
      payload: { displayName: "Sam Carter", email: "sam@vault.test", tempPassword: "temporary-pass-1" },
    });
    memberAuth = await login("sam@vault.test", "temporary-pass-1");
  });

  afterAll(async () => {
    await app.close();
    await pg.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(pgDir, { recursive: true, force: true });
  });

  describe("household name", () => {
    it("is set at setup and shown on the (unauthenticated) login screen", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/auth/profiles" });
      expect(res.json().householdName).toBe("The Carters");
      expect(res.json().profiles).toHaveLength(2);
    });

    it("both members see the same household", async () => {
      for (const headers of [ownerAuth, memberAuth]) {
        const res = await app.inject({ method: "GET", url: "/api/v1/household", headers });
        expect(res.json()).toEqual({ name: "The Carters" });
      }
    });

    it("only the owner can rename it", async () => {
      const denied = await app.inject({
        method: "PATCH",
        url: "/api/v1/household",
        headers: memberAuth,
        payload: { name: "Sam's house" },
      });
      expect(denied.statusCode).toBe(403);

      const ok = await app.inject({
        method: "PATCH",
        url: "/api/v1/household",
        headers: ownerAuth,
        payload: { name: "  Carter Family  " },
      });
      expect(ok.json()).toEqual({ name: "Carter Family" });
      const after = await app.inject({ method: "GET", url: "/api/v1/household", headers: memberAuth });
      expect(after.json().name).toBe("Carter Family");
    });

    it("rejects an empty name", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/household",
        headers: ownerAuth,
        payload: { name: "   " },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("device keys", () => {
    let key: string;
    let keyId: string;

    it("an enrolled device can sign in with its key, skipping the password", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/auth/device-keys",
        headers: memberAuth,
        payload: { deviceName: "Sam's laptop", platform: "windows" },
      });
      expect(created.statusCode).toBe(201);
      ({ key, id: keyId } = created.json());
      expect(key.startsWith(`${keyId}.`)).toBe(true);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login/device-key",
        payload: { key, deviceName: "Sam's laptop", platform: "windows" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.email).toBe("sam@vault.test");
      const me = await app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { authorization: `Bearer ${res.json().accessToken}` },
      });
      expect(me.json().displayName).toBe("Sam Carter");
    });

    it("lists only the caller's own keys, with last-used time", async () => {
      const mine = await app.inject({ method: "GET", url: "/api/v1/auth/device-keys", headers: memberAuth });
      expect(mine.json().keys).toHaveLength(1);
      expect(mine.json().keys[0].lastUsedAt).not.toBeNull();
      const owners = await app.inject({ method: "GET", url: "/api/v1/auth/device-keys", headers: ownerAuth });
      expect(owners.json().keys).toHaveLength(0);
    });

    it("another user can't revoke someone else's key", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/auth/device-keys/${keyId}`,
        headers: ownerAuth,
      });
      expect(res.statusCode).toBe(404);
    });

    it("a revoked key stops working", async () => {
      const del = await app.inject({
        method: "DELETE",
        url: `/api/v1/auth/device-keys/${keyId}`,
        headers: memberAuth,
      });
      expect(del.statusCode).toBe(204);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login/device-key",
        payload: { key, deviceName: "Sam's laptop", platform: "windows" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("a wrong secret for a real key is rejected and burns the key", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/auth/device-keys",
        headers: ownerAuth,
        payload: { deviceName: "Pat's Mac", platform: "macos" },
      });
      const { id, key: good } = created.json();
      const forged = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login/device-key",
        payload: { key: `${id}.not-the-secret`, deviceName: "x", platform: "linux" },
      });
      expect(forged.statusCode).toBe(401);
      const legit = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login/device-key",
        payload: { key: good, deviceName: "Pat's Mac", platform: "macos" },
      });
      expect(legit.statusCode).toBe(401);
    });

    it("garbage keys are a plain 401", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login/device-key",
        payload: { key: "nope", deviceName: "x", platform: "linux" },
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
