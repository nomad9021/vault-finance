import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp as buildApp } from "./helpers/test-app.js";
import { loadConfig } from "../src/config.js";

/** Your own profile: name, colour, picture; and preferences that follow you. */

const PG_PORT = 55540;
let pg: EmbeddedPostgres;
let app: FastifyInstance;
let dirs: string[] = [];
let auth: { authorization: string };
const api = async (method: string, url: string, payload?: unknown, headers = auth) => {
  const r = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: r.statusCode, body: r.json() };
};
// A real 1×1 PNG.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

beforeAll(async () => {
  dirs = [mkdtempSync(path.join(tmpdir(), "vault-pf-pg-")), mkdtempSync(path.join(tmpdir(), "vault-pf-data-"))];
  pg = new EmbeddedPostgres({ databaseDir: dirs[0]!, user: "vault", password: "vault", port: PG_PORT, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("vault");
  app = await buildApp({ config: loadConfig({ DATABASE_URL: `postgres://vault:vault@localhost:${PG_PORT}/vault`, VAULT_TLS: "off", VAULT_DATA_DIR: dirs[1], LOG_LEVEL: "error" } as NodeJS.ProcessEnv) });
  await app.inject({ method: "POST", url: "/api/v1/setup/complete", payload: { ownerEmail: "p@p.home", ownerPassword: "correct-horse-battery", ownerDisplayName: "Pat" } });
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "p@p.home", password: "correct-horse-battery", deviceName: "T", platform: "linux" } });
  auth = { authorization: `Bearer ${login.json().accessToken}` };
});

afterAll(async () => {
  await app?.close();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("profile", () => {
  it("sets a name, colour and picture, shown on the login screen too", async () => {
    const res = await api("PATCH", "/me", { displayName: "Pat Rivera", avatarColor: "#3ecf8e", avatarImage: PNG });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ displayName: "Pat Rivera", avatarColor: "#3ecf8e", avatarImage: PNG });
    const profiles = (await app.inject({ method: "GET", url: "/api/v1/auth/profiles" })).json().profiles;
    expect(profiles[0]).toMatchObject({ displayName: "Pat Rivera", avatarImage: PNG });
    expect(profiles[0].email).toBeUndefined();
  });

  it("rejects things that aren't pictures, and removes the picture", async () => {
    const fake = "data:image/png;base64," + Buffer.from("<script>alert(1)</script>").toString("base64");
    expect((await api("PATCH", "/me", { avatarImage: fake })).status).toBe(400);
    expect((await api("PATCH", "/me", { avatarImage: "javascript:alert(1)" })).status).toBe(400);
    expect((await api("PATCH", "/me", { newPassword: "a-brand-new-password", currentPassword: "correct-horse-battery" })).status).toBe(400);
    expect((await api("PATCH", "/me", { avatarImage: null })).body.avatarImage).toBeNull();
  });

  it("keeps preferences per person and merges updates", async () => {
    expect((await api("GET", "/me/preferences")).body).toEqual({});
    const layout = [{ id: "sankey", hidden: false, span: 12 }, { id: "metric-networth", hidden: true }];
    const saved = await api("PUT", "/me/preferences", { dashboard: layout });
    expect(saved.status).toBe(200);
    expect((await api("GET", "/me/preferences")).body.dashboard).toEqual(layout);
    expect((await api("PUT", "/me/preferences", { dashboard: [{ id: "x", span: 5 }] })).status).toBe(400);
  });
});
