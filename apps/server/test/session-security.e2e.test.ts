import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import argon2 from "argon2";
import { eq } from "drizzle-orm";
import EmbeddedPostgres from "embedded-postgres";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp as buildApp } from "./helpers/test-app.js";
import { loadConfig } from "../src/config.js";
import { users } from "../src/db/schema.js";
import { approveFromConsole } from "../src/modules/devices/service.js";

/**
 * Sign-out has to mean signed out: an access token dies with its session, not
 * when it expires, and changing the password locks out whoever had the old one.
 */
describe("session revocation + password change", () => {
  const PG_PORT = 55488;
  const OWNER = { email: "owner@vault.test", password: "correct-horse-battery" };
  const PHONE = {
    deviceId: "00000000-0000-4000-8000-0000000a11ce",
    deviceSecret: "second-device-secret-second-device-secret",
  };
  let pg: EmbeddedPostgres;
  let app: FastifyInstance;
  let dataDir: string;
  let pgDir: string;

  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  /** Sign in; `device` signs in from a second device, approved on the console. */
  const signIn = async (who: { email: string; password: string }, device?: typeof PHONE) => {
    const payload = { ...who, deviceName: device ? "Phone" : "Laptop", platform: "linux", ...device };
    let res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload });
    if (res.statusCode === 403 && res.json().error.code === "DEVICE_APPROVAL_REQUIRED") {
      await approveFromConsole(app.db, res.json().error.fields.code, { override: true });
      res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload });
    }
    expect(res.statusCode).toBe(200);
    return res.json() as { accessToken: string; refreshToken: string };
  };

  const me = (token: string) => app.inject({ method: "GET", url: "/api/v1/me", headers: bearer(token) });

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "vault-sess-data-"));
    pgDir = mkdtempSync(path.join(tmpdir(), "vault-sess-pg-"));
    pg = new EmbeddedPostgres({ databaseDir: pgDir, user: "vault", password: "vault", port: PG_PORT, persistent: false });
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
      payload: { ownerEmail: OWNER.email, ownerPassword: OWNER.password, ownerDisplayName: "Pat Carter" },
    });
    expect(setup.statusCode).toBe(201);
  });

  afterAll(async () => {
    await app.close();
    await pg.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(pgDir, { recursive: true, force: true });
  });

  describe("access tokens die with their session", () => {
    it("after logout", async () => {
      const s = await signIn(OWNER);
      expect((await me(s.accessToken)).statusCode).toBe(200);
      await app.inject({ method: "POST", url: "/api/v1/auth/logout", payload: { refreshToken: s.refreshToken } });
      const res = await me(s.accessToken);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("SESSION_REVOKED");
    });

    it("after the session is signed out from another device", async () => {
      const a = await signIn(OWNER);
      const b = await signIn(OWNER);
      const list = await app.inject({ method: "GET", url: "/api/v1/auth/sessions", headers: bearer(b.accessToken) });
      const bId = list.json().sessions.find((s: { isCurrent: boolean }) => s.isCurrent).id;
      await app.inject({ method: "DELETE", url: `/api/v1/auth/sessions/${bId}`, headers: bearer(a.accessToken) });
      expect((await me(b.accessToken)).statusCode).toBe(401);
      expect((await me(a.accessToken)).statusCode).toBe(200);
    });

    it("after the member is removed", async () => {
      const owner = await signIn(OWNER);
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/members",
        headers: bearer(owner.accessToken),
        payload: { displayName: "Sam", email: "sam@vault.test", tempPassword: "temporary-pass-1" },
      });
      expect(created.statusCode).toBe(201);
      const sam = await signIn({ email: "sam@vault.test", password: "temporary-pass-1" });
      expect((await me(sam.accessToken)).statusCode).toBe(200);
      const del = await app.inject({
        method: "DELETE",
        url: `/api/v1/members/${created.json().id}`,
        headers: bearer(owner.accessToken),
      });
      expect(del.statusCode).toBe(204);
      const res = await app.inject({ method: "GET", url: "/api/v1/accounts", headers: bearer(sam.accessToken) });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("changing the password", () => {
    it("needs the current password", async () => {
      const s = await signIn(OWNER);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/password",
        headers: bearer(s.accessToken),
        payload: { currentPassword: "not-my-password", newPassword: "a-brand-new-passphrase" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("rejects weak new passwords", async () => {
      const s = await signIn(OWNER);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/password",
        headers: bearer(s.accessToken),
        payload: { currentPassword: OWNER.password, newPassword: "short" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("cancels sign-in requests made with the old password", async () => {
      const owner = await signIn(OWNER);
      const kim = { email: "kim@vault.test", password: "kims-first-password" };
      await app.inject({
        method: "POST",
        url: "/api/v1/members",
        headers: bearer(owner.accessToken),
        payload: { displayName: "Kim", email: kim.email, tempPassword: kim.password },
      });
      const laptop = await signIn(kim);
      const TABLET = { deviceId: "00000000-0000-4000-8000-0000000ab1e7", deviceSecret: "tablet-device-secret-tablet-device-secret" };
      const pending = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { ...kim, deviceName: "Tablet", platform: "linux", ...TABLET },
      });
      expect(pending.json().error.code).toBe("DEVICE_APPROVAL_REQUIRED");
      const { approvalId, code } = pending.json().error.fields;

      const changed = await app.inject({
        method: "POST",
        url: "/api/v1/auth/password",
        headers: bearer(laptop.accessToken),
        payload: { currentPassword: kim.password, newPassword: "kims-brand-new-passphrase" },
      });
      expect(changed.statusCode).toBe(204);

      await expect(approveFromConsole(app.db, code, { override: true })).rejects.toThrow();
      const poll = await app.inject({
        method: "POST",
        url: "/api/v1/auth/device-approval/status",
        payload: { approvalId, ...TABLET },
      });
      expect(poll.json().status).toBe("denied");
    });

    it("signs out every other device and deletes their biometric keys, keeping this one", async () => {
      const here = await signIn(OWNER);
      const phone = await signIn(OWNER, PHONE);
      const enroll = (token: string) =>
        app.inject({
          method: "POST",
          url: "/api/v1/auth/device-keys",
          headers: bearer(token),
          payload: { deviceName: "x", platform: "linux" },
        });
      const hereKey = (await enroll(here.accessToken)).json().id as string;
      const phoneKey = (await enroll(phone.accessToken)).json().id as string;

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/password",
        headers: bearer(here.accessToken),
        payload: { currentPassword: OWNER.password, newPassword: "a-brand-new-passphrase" },
      });
      expect(res.statusCode).toBe(204);

      expect((await me(here.accessToken)).statusCode).toBe(200);
      expect((await me(phone.accessToken)).statusCode).toBe(401);
      const refresh = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: { refreshToken: phone.refreshToken, ...PHONE },
      });
      expect(refresh.statusCode).toBe(401);

      const keys = await app.inject({ method: "GET", url: "/api/v1/auth/device-keys", headers: bearer(here.accessToken) });
      const ids = keys.json().keys.map((k: { id: string }) => k.id);
      expect(ids).toContain(hereKey);
      expect(ids).not.toContain(phoneKey);

      // (Checked on the stored hash: this file has used up the sign-in rate limit.)
      const row = await app.db.query.users.findFirst({ where: eq(users.email, OWNER.email) });
      expect(await argon2.verify(row!.passwordHash, "a-brand-new-passphrase")).toBe(true);
      expect(await argon2.verify(row!.passwordHash, OWNER.password)).toBe(false);
    });
  });
});
