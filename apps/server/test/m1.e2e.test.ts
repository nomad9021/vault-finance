import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

/**
 * M1 exit criteria, end to end against a real Postgres:
 * setup wizard → login → authenticated call → refresh rotation →
 * reuse detection → session list/revoke → version gate.
 */

const PG_PORT = 55432;
let pg: EmbeddedPostgres;
let app: FastifyInstance;
let dataDir: string;
let pgDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "vault-data-"));
  pgDir = mkdtempSync(path.join(tmpdir(), "vault-pg-"));

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

  const config = loadConfig({
    DATABASE_URL: `postgres://vault:vault@localhost:${PG_PORT}/vault`,
    VAULT_TLS: "off",
    VAULT_DATA_DIR: dataDir,
    LOG_LEVEL: "error",
  } as NodeJS.ProcessEnv);

  app = await buildApp({ config }); // runMigrations defaults to true — the boot path under test
});

afterAll(async () => {
  await app?.close();
  await pg?.stop();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(pgDir, { recursive: true, force: true });
});

const OWNER = {
  ownerEmail: "Maya@Chen.home", // mixed case on purpose — must normalize
  ownerPassword: "correct-horse-battery",
  ownerDisplayName: "Maya Chen",
};

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("meta", () => {
  it("reports version and health", async () => {
    const version = await app.inject({ method: "GET", url: "/api/v1/version" });
    expect(version.statusCode).toBe(200);
    expect(version.json()).toEqual({ apiVersion: "0.1.0", minClientVersion: "0.1.0" });

    const health = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(health.statusCode).toBe(200);
  });

  it("blocks clients older than minClientVersion with 426", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/version",
      headers: { "x-client-version": "0.0.1" },
    });
    expect(res.statusCode).toBe(426);
    expect(res.json().error.code).toBe("CLIENT_VERSION_TOO_OLD");
  });

  it("lets a current client through", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/version",
      headers: { "x-client-version": "0.1.0" },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("setup wizard", () => {
  it("reports needsSetup=true on a fresh server", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/setup/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ needsSetup: true });
  });

  it("rejects a weak owner password", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/setup/complete",
      payload: { ...OWNER, ownerPassword: "short" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("completes setup: owner user, AI defaults, seeded categories", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/setup/complete",
      payload: OWNER,
    });
    expect(res.statusCode).toBe(201);

    const status = await app.inject({ method: "GET", url: "/api/v1/setup/status" });
    expect(status.json()).toEqual({ needsSetup: false });

    const cats = await app.sql`select count(*)::int as n from categories where is_system`;
    expect(cats[0]!["n"]).toBeGreaterThanOrEqual(14);

    const ai = await app.sql`select * from ai_settings`;
    expect(ai).toHaveLength(1);
  });

  it("refuses to run setup twice", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/setup/complete",
      payload: OWNER,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("SETUP_ALREADY_COMPLETE");
  });
});

describe("auth", () => {
  let accessToken: string;
  let refreshToken: string;

  it("rejects a wrong password", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "maya@chen.home",
        password: "wrong-password-entirely",
        deviceName: "Test laptop",
        platform: "linux",
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("INVALID_CREDENTIALS");
  });

  it("logs in with a case-insensitive email and returns tokens + user", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "MAYA@chen.home",
        password: OWNER.ownerPassword,
        deviceName: "Test laptop",
        platform: "linux",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user).toMatchObject({
      email: "maya@chen.home",
      displayName: "Maya Chen",
      role: "owner",
    });
    accessToken = body.accessToken;
    refreshToken = body.refreshToken;
  });

  it("authenticates /me with the access token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: authHeader(accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe("maya@chen.home");
  });

  it("rejects a garbage access token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: authHeader("not-a-jwt"),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("TOKEN_INVALID");
  });

  it("rotates the refresh token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.refreshToken).not.toBe(refreshToken);

    // The new access token works.
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: authHeader(body.accessToken),
    });
    expect(me.statusCode).toBe(200);

    // Keep both: old one for the reuse test, new one to prove revocation cascades.
    const oldToken = refreshToken;
    refreshToken = body.refreshToken;

    // Replaying the pre-rotation token revokes the whole session (ADR-0003).
    const reuse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: oldToken },
    });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().error.code).toBe("REFRESH_TOKEN_REUSED");

    // …which also kills the *current* token of that session.
    const afterRevoke = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken },
    });
    expect(afterRevoke.statusCode).toBe(401);
    expect(afterRevoke.json().error.code).toBe("SESSION_REVOKED");
  });

  it("lists and revokes device sessions", async () => {
    // Two fresh logins → two live sessions.
    const loginA = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "maya@chen.home",
        password: OWNER.ownerPassword,
        deviceName: "Desktop A",
        platform: "windows",
      },
    });
    const loginB = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "maya@chen.home",
        password: OWNER.ownerPassword,
        deviceName: "Desktop B",
        platform: "macos",
      },
    });
    const a = loginA.json();
    const b = loginB.json();

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/auth/sessions",
      headers: authHeader(a.accessToken),
    });
    expect(list.statusCode).toBe(200);
    const { sessions } = list.json();
    const names = sessions.map((s: { deviceName: string }) => s.deviceName);
    expect(names).toContain("Desktop A");
    expect(names).toContain("Desktop B");
    const current = sessions.find((s: { isCurrent: boolean }) => s.isCurrent);
    expect(current.deviceName).toBe("Desktop A");

    // Revoke B from A ("lost laptop" flow), then B's refresh must fail.
    const bSession = sessions.find(
      (s: { deviceName: string }) => s.deviceName === "Desktop B",
    );
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/sessions/${bSession.id}`,
      headers: authHeader(a.accessToken),
    });
    expect(del.statusCode).toBe(204);

    const bRefresh = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: b.refreshToken },
    });
    expect(bRefresh.statusCode).toBe(401);
    expect(bRefresh.json().error.code).toBe("SESSION_REVOKED");
  });

  it("logs out idempotently", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "maya@chen.home",
        password: OWNER.ownerPassword,
        deviceName: "Ephemeral",
        platform: "linux",
      },
    });
    const { refreshToken: rt } = login.json();

    const out1 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      payload: { refreshToken: rt },
    });
    expect(out1.statusCode).toBe(204);

    const out2 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      payload: { refreshToken: rt },
    });
    expect(out2.statusCode).toBe(204);

    const refresh = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: rt },
    });
    expect(refresh.statusCode).toBe(401);
  });
});
