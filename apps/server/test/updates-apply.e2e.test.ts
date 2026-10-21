import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp as buildApp } from "./helpers/test-app.js";
import { loadConfig } from "../src/config.js";
import { readSelfUpdate } from "../src/modules/updates/agent.js";

describe("in-app server update", () => {
  // The running version, whatever release this branch is on.
  const CURRENT = loadConfig({ DATABASE_URL: "postgres://x@localhost/x" } as NodeJS.ProcessEnv).apiVersion;
  const PG_PORT = 55463;
  let pg: EmbeddedPostgres;
  let app: FastifyInstance;
  let dataDir: string;
  let pgDir: string;
  let agentDir: string;
  let owner: { authorization: string };
  let member: { authorization: string };
  let manifest: Server;
  let manifestUrl: string;
  let latestTag = `v${CURRENT}`; // same as apiVersion → no update

  const post = (url: string, headers: { authorization: string }) =>
    app.inject({ method: "POST", url: `/api/v1${url}`, headers });
  const status = async () =>
    (await app.inject({ method: "GET", url: "/api/v1/updates/status", headers: owner })).json();

  beforeAll(async () => {
    manifest = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ tag_name: latestTag, html_url: "https://example.test/notes" }));
    });
    await new Promise<void>((r) => manifest.listen(0, "127.0.0.1", r));
    const addr = manifest.address();
    if (typeof addr === "object" && addr) manifestUrl = `http://127.0.0.1:${addr.port}/latest`;

    dataDir = mkdtempSync(path.join(tmpdir(), "vault-apply-data-"));
    pgDir = mkdtempSync(path.join(tmpdir(), "vault-apply-pg-"));
    agentDir = mkdtempSync(path.join(tmpdir(), "vault-apply-agent-"));
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
        UPDATE_MANIFEST_URL: manifestUrl,
        UPDATE_AGENT_DIR: agentDir,
      } as NodeJS.ProcessEnv),
    });

    await app.inject({
      method: "POST",
      url: "/api/v1/setup/complete",
      payload: {
        ownerEmail: "owner@vault.test",
        ownerPassword: "correct-horse-battery",
        ownerDisplayName: "Owner",
      },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "owner@vault.test", password: "correct-horse-battery", deviceName: "t", platform: "linux" },
    });
    owner = { authorization: `Bearer ${login.json().accessToken}` };

    await app.inject({
      method: "POST",
      url: "/api/v1/members",
      headers: owner,
      payload: { displayName: "Kid", email: "kid@vault.test", tempPassword: "temporary-pass-1" },
    });
    const kid = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "kid@vault.test", password: "temporary-pass-1", deviceName: "k", platform: "linux" },
    });
    member = { authorization: `Bearer ${kid.json().accessToken}` };
  });

  afterAll(async () => {
    await app.close();
    await pg.stop();
    await new Promise<void>((r) => manifest.close(() => r()));
    for (const d of [dataDir, pgDir, agentDir]) rmSync(d, { recursive: true, force: true });
  });

  it("isn't offered until the host agent is installed", async () => {
    expect((await status()).selfUpdate).toBeNull();
    latestTag = "v0.9.0";
    const res = await post("/updates/apply", owner);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("UPDATE_UNAVAILABLE");
    expect(res.json().error.message).toMatch(/enable-app-updates/);
    expect(existsSync(path.join(agentDir, "request.json"))).toBe(false);
  });

  it("is owner-only", async () => {
    writeFileSync(path.join(agentDir, "agent.json"), '{"agent":1}\n');
    expect((await post("/updates/apply", member)).statusCode).toBe(403);
    expect((await post("/updates/check", member)).statusCode).toBe(403);
    expect(existsSync(path.join(agentDir, "request.json"))).toBe(false);
  });

  it("refuses when the server is already current", async () => {
    latestTag = `v${CURRENT}`;
    const checked = (await post("/updates/check", owner)).json();
    expect(checked.updateAvailable).toBe(false);
    expect(checked.selfUpdate.state).toBe("idle");
    const res = await post("/updates/apply", owner);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/latest version/);
  });

  it("hands the update to the agent and reports it as requested", async () => {
    latestTag = "v0.9.0";
    const res = await post("/updates/apply", owner);
    expect(res.statusCode).toBe(200);
    expect(res.json().selfUpdate.state).toBe("requested");
    expect(res.json().selfUpdate.targetVersion).toBe("0.9.0");

    const req = JSON.parse(readFileSync(path.join(agentDir, "request.json"), "utf8"));
    expect(req).toMatchObject({ targetVersion: "0.9.0", fromVersion: CURRENT });

    // A second press while one is pending is refused.
    const again = await post("/updates/apply", owner);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toMatch(/already in progress/);
  });

  it("reports the agent's progress", async () => {
    unlinkSync(path.join(agentDir, "request.json")); // the agent takes the request
    const running = {
      state: "running",
      message: "Downloading and installing the update…",
      targetVersion: "0.9.0",
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    writeFileSync(path.join(agentDir, "status.json"), JSON.stringify(running));
    expect((await status()).selfUpdate).toMatchObject({ state: "running", targetVersion: "0.9.0" });
    expect((await post("/updates/apply", owner)).statusCode).toBe(409);

    writeFileSync(
      path.join(agentDir, "status.json"),
      JSON.stringify({ ...running, state: "failed", message: "The update failed: boom.", finishedAt: new Date().toISOString() }),
    );
    expect((await status()).selfUpdate).toMatchObject({ state: "failed", message: "The update failed: boom." });
    // After a failure the owner can try again.
    expect((await post("/updates/apply", owner)).statusCode).toBe(200);
  });

  it("flags a request the agent never picked up, and ignores a garbled status file", () => {
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(path.join(agentDir, "request.json"), old, old);
    expect(readSelfUpdate(agentDir)).toMatchObject({ state: "failed" });
    expect(readSelfUpdate(agentDir)!.message).toMatch(/vault-update\.path/);

    unlinkSync(path.join(agentDir, "request.json"));
    writeFileSync(path.join(agentDir, "status.json"), "{not json");
    expect(readSelfUpdate(agentDir)).toMatchObject({ state: "idle" });
  });
});
