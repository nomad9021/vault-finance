import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { buildTestApp as buildApp, TEST_DEVICE } from "./helpers/test-app.js";
import { loadConfig } from "../src/config.js";
import { deviceKeys, trustedDevices } from "../src/db/schema.js";
import { approveFromConsole } from "../src/modules/devices/service.js";

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

  // A key is bound to the approved device that enrolled it: it must never
  // approve a device on its own, and it dies with that device's approval.
  describe("device keys are bound to their device", () => {
    const LAPTOP = {
      deviceId: "00000000-0000-4000-8000-00000000d1d1",
      deviceSecret: "laptop-device-secret-laptop-device-secret",
    };
    const THIEF = {
      deviceId: "00000000-0000-4000-8000-00000000dbad",
      deviceSecret: "thief-device-secret-thief-device-secret-00",
    };

    /** Password sign-in as Sam on `device`, approving it from the console if asked. */
    const signInOn = async (device: typeof LAPTOP) => {
      const payload = {
        email: "sam@vault.test",
        password: "temporary-pass-1",
        deviceName: "Sam's laptop",
        platform: "windows",
        ...device,
      };
      let res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload });
      if (res.statusCode === 403 && res.json().error.code === "DEVICE_APPROVAL_REQUIRED") {
        await approveFromConsole(app.db, res.json().error.fields.code, { override: true });
        res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload });
      }
      expect(res.statusCode).toBe(200);
      return { authorization: `Bearer ${res.json().accessToken}` };
    };

    const enroll = async (auth: { authorization: string }) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/device-keys",
        headers: auth,
        payload: { deviceName: "Sam's laptop", platform: "windows" },
      });
      expect(res.statusCode).toBe(201);
      return res.json() as { id: string; key: string };
    };

    const keyLogin = (key: string, device: typeof LAPTOP) =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/login/device-key",
        payload: { key, deviceName: "Sam's laptop", platform: "windows", ...device },
      });

    const keyExists = async (id: string) =>
      Boolean(await app.db.query.deviceKeys.findFirst({ where: eq(deviceKeys.id, id) }));

    it("works on the device that enrolled it", async () => {
      const { key } = await enroll(await signInOn(LAPTOP));
      expect((await keyLogin(key, LAPTOP)).statusCode).toBe(200);
    });

    it("a stolen key can't sign in, or get approved, from an unknown device", async () => {
      const { id, key } = await enroll(await signInOn(LAPTOP));
      const stolen = await keyLogin(key, THIEF);
      expect(stolen.statusCode).toBe(401);
      const thiefDevice = await app.db.query.trustedDevices.findFirst({
        where: eq(trustedDevices.deviceId, THIEF.deviceId),
      });
      expect(thiefDevice?.status).not.toBe("approved");
      // The key is burned, so the legitimate device needs its password too.
      expect(await keyExists(id)).toBe(false);
      expect((await keyLogin(key, LAPTOP)).statusCode).toBe(401);
    });

    it("doesn't work from another of the user's approved devices", async () => {
      const { key } = await enroll(await signInOn(LAPTOP));
      expect((await keyLogin(key, TEST_DEVICE)).statusCode).toBe(401);
    });

    it("revoking the device deletes its keys", async () => {
      const laptopAuth = await signInOn(LAPTOP);
      const { id, key } = await enroll(laptopAuth);
      const list = await app.inject({ method: "GET", url: "/api/v1/devices", headers: laptopAuth });
      const laptop = list.json().devices.find((d: { current: boolean }) => d.current);
      const del = await app.inject({ method: "DELETE", url: `/api/v1/devices/${laptop.id}`, headers: memberAuth });
      expect(del.statusCode).toBe(204);

      expect(await keyExists(id)).toBe(false);
      expect((await keyLogin(key, LAPTOP)).statusCode).toBe(401);
      const device = await app.db.query.trustedDevices.findFirst({ where: eq(trustedDevices.id, laptop.id) });
      expect(device?.revokedAt).not.toBeNull();
    });

    it("signing the device out remotely deletes its keys", async () => {
      const { id, key } = await enroll(await signInOn(LAPTOP));
      const list = await app.inject({ method: "GET", url: "/api/v1/auth/sessions", headers: memberAuth });
      const laptopSessions = list
        .json()
        .sessions.filter((s: { deviceName: string; isCurrent: boolean }) => s.deviceName === "Sam's laptop");
      for (const session of laptopSessions) {
        await app.inject({ method: "DELETE", url: `/api/v1/auth/sessions/${session.id}`, headers: memberAuth });
      }
      expect(await keyExists(id)).toBe(false);
      expect((await keyLogin(key, LAPTOP)).statusCode).toBe(401);
    });

    it("a signed-out session can't enroll a key with its leftover access token", async () => {
      const laptopAuth = await signInOn(LAPTOP);
      const list = await app.inject({ method: "GET", url: "/api/v1/auth/sessions", headers: laptopAuth });
      const current = list.json().sessions.find((s: { isCurrent: boolean }) => s.isCurrent);
      await app.inject({ method: "DELETE", url: `/api/v1/auth/sessions/${current.id}`, headers: memberAuth });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/device-keys",
        headers: laptopAuth,
        payload: { deviceName: "Sam's laptop", platform: "windows" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("a key enrolled before binding adopts the approved device it's first used on", async () => {
      // LAPTOP is approved again from the tests above (session sign-out keeps the approval).
      const sam = (await app.inject({ method: "GET", url: "/api/v1/me", headers: memberAuth })).json();
      const secret = "legacy-device-key-secret-legacy-device-key";
      const [legacy] = await app.db
        .insert(deviceKeys)
        .values({ userId: sam.id, deviceName: "Old key", platform: "windows", secretHash: await argon2.hash(secret) })
        .returning();
      const key = `${legacy!.id}.${secret}`;

      expect((await keyLogin(key, THIEF)).statusCode).toBe(401);
      const [again] = await app.db
        .insert(deviceKeys)
        .values({ userId: sam.id, deviceName: "Old key", platform: "windows", secretHash: await argon2.hash(secret) })
        .returning();
      const key2 = `${again!.id}.${secret}`;
      expect((await keyLogin(key2, LAPTOP)).statusCode).toBe(200);
      const bound = await app.db.query.deviceKeys.findFirst({ where: eq(deviceKeys.id, again!.id) });
      const laptop = await app.db.query.trustedDevices.findFirst({
        where: eq(trustedDevices.deviceId, LAPTOP.deviceId),
      });
      expect(bound?.trustedDeviceId).toBe(laptop!.id);
      expect((await keyLogin(key2, TEST_DEVICE)).statusCode).toBe(401);
    });
  });
});
