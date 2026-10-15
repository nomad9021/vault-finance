import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { deviceSessions, trustedDevices } from "../src/db/schema.js";
import { approveFromConsole, listPending } from "../src/modules/devices/service.js";

/**
 * Device approval (ADR-0009): the right password isn't enough — a new device
 * waits until a trusted device (by number matching) or the server console
 * lets it in.
 */
describe("device approval", () => {
  const PG_PORT = 55481;
  let pg: EmbeddedPostgres;
  let app: FastifyInstance;
  const OWNER = { email: "sam@sam.home", password: "correct-horse-battery" };
  const MEMBER = { email: "kid@sam.home", password: "temporary-pass-1" };

  const newDevice = () => ({ deviceId: randomUUID(), deviceSecret: randomBytes(32).toString("base64url") });
  type Device = ReturnType<typeof newDevice>;

  // Each sign-in from its own address, so the login rate limit (10 per address
  // and account) doesn't get in the way of this many sign-ins.
  let ip = 1;
  const signIn = (who: { email: string; password: string }, device: Device | Record<string, never>, name = "Laptop") =>
    app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress: `10.0.0.${ip++}`,
      payload: { ...who, deviceName: name, platform: "linux", ...device },
    });
  const poll = (approvalId: string, device: Device) =>
    app.inject({ method: "POST", url: "/api/v1/auth/device-approval/status", payload: { approvalId, ...device } });
  const as = (token: string) => ({ authorization: `Bearer ${token}` });

  let ownerToken: string;
  let ownerDevice: Device;

  beforeAll(async () => {
    const pgDir = mkdtempSync(path.join(tmpdir(), "vault-devapp-pg-"));
    pg = new EmbeddedPostgres({ databaseDir: pgDir, user: "vault", password: "vault", port: PG_PORT, persistent: false });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("vault");
    app = await buildApp({
      config: loadConfig({
        DATABASE_URL: `postgres://vault:vault@localhost:${PG_PORT}/vault`,
        VAULT_TLS: "off",
        VAULT_DATA_DIR: mkdtempSync(path.join(tmpdir(), "vault-devapp-data-")),
        LOG_LEVEL: "error",
        UPDATE_CHECK_ENABLED: "false",
      } as NodeJS.ProcessEnv),
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/setup/complete",
      payload: { ownerEmail: OWNER.email, ownerPassword: OWNER.password, ownerDisplayName: "Sam" },
    });
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  it("refuses an app that doesn't send a device identity", async () => {
    const res = await signIn(OWNER, {});
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("DEVICE_NOT_TRUSTED");
  });

  it("lets the owner's very first device straight in", async () => {
    ownerDevice = newDevice();
    const res = await signIn(OWNER, ownerDevice, "Owner desktop");
    expect(res.statusCode).toBe(200);
    ownerToken = res.json().accessToken;
    const list = (await app.inject({ method: "GET", url: "/api/v1/devices", headers: as(ownerToken) })).json();
    expect(list.devices).toHaveLength(1);
    expect(list.devices[0]).toMatchObject({ deviceName: "Owner desktop", approvedVia: "bootstrap", current: true });
  });

  it("makes a second device wait, approves it by number matching, and hands out one session", async () => {
    const phone = newDevice();
    const first = await signIn(OWNER, phone, "Second laptop");
    expect(first.statusCode).toBe(403);
    const ch = first.json().error.fields;
    expect(first.json().error.code).toBe("DEVICE_APPROVAL_REQUIRED");
    expect(ch.code).toMatch(/^\d{6}$/);
    expect(ch.methods).toBe("trustedDevice,serverConsole");

    // Signing in again while waiting keeps the same request and code.
    const again = (await signIn(OWNER, phone, "Second laptop")).json().error.fields;
    expect(again).toMatchObject({ approvalId: ch.approvalId, code: ch.code });

    expect((await poll(ch.approvalId, phone)).json()).toMatchObject({ status: "pending" });

    // The approver sees the request, but never the code.
    const pending = (await app.inject({ method: "GET", url: "/api/v1/devices/approvals", headers: as(ownerToken) })).json();
    expect(pending.approvals).toHaveLength(1);
    expect(pending.approvals[0]).toMatchObject({ id: ch.approvalId, deviceName: "Second laptop", userDisplayName: "Sam" });
    expect(JSON.stringify(pending)).not.toContain(ch.code);

    const wrong = String((Number(ch.code) + 1) % 1_000_000).padStart(6, "0");
    const bad = await app.inject({
      method: "POST",
      url: `/api/v1/devices/approvals/${ch.approvalId}/approve`,
      headers: as(ownerToken),
      payload: { code: wrong },
    });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({
      method: "POST",
      url: `/api/v1/devices/approvals/${ch.approvalId}/approve`,
      headers: as(ownerToken),
      payload: { code: ch.code },
    });
    expect(ok.statusCode).toBe(204);

    const approved = (await poll(ch.approvalId, phone)).json();
    expect(approved.status).toBe("approved");
    expect(approved.login.accessToken).toBeTruthy();
    // Exactly once — the device secret alone can't mint more sessions.
    expect((await poll(ch.approvalId, phone)).json()).toEqual({ status: "expired" });
    // From now on it signs in normally.
    expect((await signIn(OWNER, phone, "Second laptop")).statusCode).toBe(200);
  });

  it("won't tell a poller anything without the device's secret", async () => {
    const d = newDevice();
    const ch = (await signIn(OWNER, d)).json().error.fields;
    const res = await poll(ch.approvalId, { ...d, deviceSecret: randomBytes(32).toString("base64url") });
    expect(res.statusCode).toBe(404);
  });

  it("lets the console approve a member's device, and the owner see members' requests", async () => {
    await app.inject({
      method: "POST",
      url: "/api/v1/members",
      headers: as(ownerToken),
      payload: { displayName: "Kid", email: MEMBER.email, tempPassword: MEMBER.password },
    });
    const kidLaptop = newDevice();
    const ch = (await signIn(MEMBER, kidLaptop, "Kid laptop")).json().error.fields;

    const ownerView = (await app.inject({ method: "GET", url: "/api/v1/devices/approvals", headers: as(ownerToken) })).json();
    expect(ownerView.approvals.map((a: { deviceName: string }) => a.deviceName)).toContain("Kid laptop");

    // The console view is the only one that includes codes.
    const consoleView = await listPending(app.db, null);
    expect(consoleView.find((a) => a.id === ch.approvalId)?.code).toBe(ch.code);

    await approveFromConsole(app.db, ch.code);
    const res = (await poll(ch.approvalId, kidLaptop)).json();
    expect(res.status).toBe("approved");

    // A member only sees their own devices.
    const kidToken = res.login.accessToken;
    const kidList = (await app.inject({ method: "GET", url: "/api/v1/devices", headers: as(kidToken) })).json();
    expect(kidList.devices.map((d: { deviceName: string }) => d.deviceName)).toEqual(["Kid laptop"]);
  });

  it("reports a denied request to the waiting device", async () => {
    const d = newDevice();
    const ch = (await signIn(OWNER, d, "Unknown PC")).json().error.fields;
    const deny = await app.inject({
      method: "POST",
      url: `/api/v1/devices/approvals/${ch.approvalId}/deny`,
      headers: as(ownerToken),
      payload: {},
    });
    expect(deny.statusCode).toBe(204);
    expect((await poll(ch.approvalId, d)).json()).toEqual({ status: "denied" });
  });

  it("denies a request after too many wrong codes", async () => {
    const d = newDevice();
    const ch = (await signIn(OWNER, d, "Guessing PC")).json().error.fields;
    const wrong = String((Number(ch.code) + 7) % 1_000_000).padStart(6, "0");
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: "POST",
        url: `/api/v1/devices/approvals/${ch.approvalId}/approve`,
        headers: as(ownerToken),
        payload: { code: wrong },
      });
    }
    expect((await poll(ch.approvalId, d)).json()).toEqual({ status: "denied" });
  });

  it("follows the owner's choice of approval methods, and never allows neither", async () => {
    const put = (body: object) =>
      app.inject({ method: "PUT", url: "/api/v1/devices/approval-settings", headers: as(ownerToken), payload: body });

    expect((await put({ trustedDevice: false, serverConsole: false })).statusCode).toBe(400);

    expect((await put({ trustedDevice: false, serverConsole: true })).statusCode).toBe(200);
    const d1 = newDevice();
    const ch1 = (await signIn(OWNER, d1)).json().error.fields;
    expect(ch1.methods).toBe("serverConsole");
    const viaDevice = await app.inject({
      method: "POST",
      url: `/api/v1/devices/approvals/${ch1.approvalId}/approve`,
      headers: as(ownerToken),
      payload: { code: ch1.code },
    });
    expect(viaDevice.statusCode).toBe(403);

    expect((await put({ trustedDevice: true, serverConsole: false })).statusCode).toBe(200);
    await expect(approveFromConsole(app.db, ch1.code)).rejects.toThrow(/turned off/);
    // --override is the recovery path for a locked-out owner.
    await approveFromConsole(app.db, ch1.code, { override: true });
    expect((await poll(ch1.approvalId, d1)).json().status).toBe("approved");

    await put({ trustedDevice: true, serverConsole: true });
  });

  it("revoking a device signs it out and makes it ask again", async () => {
    const d = newDevice();
    const ch = (await signIn(OWNER, d, "Old tablet")).json().error.fields;
    await approveFromConsole(app.db, ch.code);
    const login = (await poll(ch.approvalId, d)).json().login;

    const list = (await app.inject({ method: "GET", url: "/api/v1/devices", headers: as(ownerToken) })).json();
    const tablet = list.devices.find((x: { deviceName: string }) => x.deviceName === "Old tablet");
    const del = await app.inject({ method: "DELETE", url: `/api/v1/devices/${tablet.id}`, headers: as(ownerToken) });
    expect(del.statusCode).toBe(204);

    const refreshed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: login.refreshToken },
    });
    expect(refreshed.statusCode).toBe(401);
    expect((await signIn(OWNER, d, "Old tablet")).json().error.code).toBe("DEVICE_APPROVAL_REQUIRED");
  });

  it("rejects an approved device id presented with the wrong secret", async () => {
    const res = await signIn(OWNER, { ...ownerDevice, deviceSecret: randomBytes(32).toString("base64url") });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("DEVICE_NOT_TRUSTED");
  });

  it("works from the server console command", async () => {
    const env = { ...process.env, DATABASE_URL: `postgres://vault:vault@localhost:${PG_PORT}/vault` };
    const vault = (...args: string[]) =>
      promisify(execFile)("node_modules/.bin/tsx", ["src/cli.ts", ...args], { env }).catch((e) => e as { stdout: string; code: number });

    const d = newDevice();
    const ch = (await signIn(OWNER, d, "Console PC")).json().error.fields;
    const pending = await vault("pending");
    expect(pending.stdout).toContain(ch.code);
    expect(pending.stdout).toContain("Console PC");

    const approved = await vault("approve", ch.code);
    expect(approved.stdout).toMatch(/Approved: Sam · Console PC/);
    expect((await poll(ch.approvalId, d)).json().status).toBe("approved");
    expect((await vault("devices")).stdout).toContain("Console PC");

    const off = await vault("methods", "device=off", "console=off");
    expect(off.code).toBe(1); // refused: at least one must stay on
  }, 60_000);

  it("serves a phone viewer whose sign-in script still parses and handles approval", async () => {
    const html = (await app.inject({ method: "GET", url: "/" })).body;
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts.length).toBeGreaterThan(0);
    // Parse only (never run) every inline script.
    for (const src of scripts) expect(() => new Function(src)).not.toThrow();
    const all = scripts.join("\n");
    expect(all).toContain("DEVICE_APPROVAL_REQUIRED");
    expect(all).toContain("/api/v1/auth/device-approval/status");
  });

  it("keeps people signed in across the upgrade by adopting their existing session's device", async () => {
    // Simulate a session from before device approval: no device attached.
    const login = await signIn(OWNER, ownerDevice);
    const { refreshToken } = login.json();
    const sessionId = refreshToken.split(".")[0];
    await app.db.update(deviceSessions).set({ trustedDeviceId: null }).where(eq(deviceSessions.id, sessionId));

    const upgraded = newDevice();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken, ...upgraded },
    });
    expect(res.statusCode).toBe(200);
    const row = await app.db.query.trustedDevices.findFirst({ where: eq(trustedDevices.deviceId, upgraded.deviceId) });
    expect(row).toMatchObject({ status: "approved", approvedVia: "existing-session" });
    // …and that device can now sign in without approval.
    expect((await signIn(OWNER, upgraded)).statusCode).toBe(200);
  });
});
