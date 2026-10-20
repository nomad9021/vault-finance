import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp as buildApp } from "./helpers/test-app.js";
import { loadConfig } from "../src/config.js";

/**
 * Startup health checks (/status, /status/details) and the separate-AI-server
 * path: "Test connection" against an Ollama and an OpenAI-compatible server
 * running elsewhere, with plain-language failures instead of "fetch failed".
 */
describe("status checks and separate AI servers", () => {
  const PG_PORT = 55480;
  let pg: EmbeddedPostgres;
  let app: FastifyInstance;
  let owner: { authorization: string };
  let mock: Server;
  let base: string;
  let manifest: Server;

  const post = (url: string, payload: unknown, headers = owner) =>
    app.inject({ method: "POST", url, headers, payload });
  const get = (url: string, headers: Record<string, string> = owner) =>
    app.inject({ method: "GET", url, headers });

  beforeAll(async () => {
    // One fake "AI machine": an Ollama that wants a bearer token, and an
    // OpenAI-compatible server under /v1.
    mock = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/tags") {
        if (req.headers.authorization !== "Bearer let-me-in") {
          res.statusCode = 401;
          return res.end("{}");
        }
        return res.end(JSON.stringify({ models: [{ name: "llama3.2:3b" }, { name: "qwen2.5:7b" }] }));
      }
      if (req.url === "/v1/models") {
        return res.end(
          JSON.stringify({ object: "list", data: [{ id: "local-model", object: "model", created: 0, owned_by: "me" }] }),
        );
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;

    manifest = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ version: "0.1.7", notes: "", platforms: {} }));
    });
    await new Promise<void>((r) => manifest.listen(0, "127.0.0.1", r));

    const pgDir = mkdtempSync(path.join(tmpdir(), "vault-status-pg-"));
    pg = new EmbeddedPostgres({ databaseDir: pgDir, user: "vault", password: "vault", port: PG_PORT, persistent: false });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("vault");

    app = await buildApp({
      config: loadConfig({
        DATABASE_URL: `postgres://vault:vault@localhost:${PG_PORT}/vault`,
        VAULT_TLS: "off",
        VAULT_DATA_DIR: mkdtempSync(path.join(tmpdir(), "vault-status-data-")),
        LOG_LEVEL: "error",
        UPDATE_CHECK_ENABLED: "false",
        UPDATE_MANIFEST_URL: `http://127.0.0.1:${(manifest.address() as AddressInfo).port}/latest.json`,
      } as NodeJS.ProcessEnv),
    });

    await app.inject({
      method: "POST",
      url: "/api/v1/setup/complete",
      payload: { ownerEmail: "sam@sam.home", ownerPassword: "correct-horse-battery", ownerDisplayName: "Sam" },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "sam@sam.home", password: "correct-horse-battery", deviceName: "T", platform: "linux" },
    });
    owner = { authorization: `Bearer ${login.json().accessToken}` };
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
    mock?.close();
    manifest?.close();
  });

  it("reports component health without a session", async () => {
    const res = await get("/api/v1/status", {});
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.apiVersion).toMatch(/^\d+\.\d+\.\d+$/);
    const byId = Object.fromEntries(body.checks.map((c: { id: string; level: string }) => [c.id, c.level]));
    expect(byId.database).toBe("ok");
    expect(["ok", "warn"]).toContain(byId.storage);
  });

  it("keeps the detailed checks behind sign-in, with optional features reported as off", async () => {
    expect((await get("/api/v1/status/details", {})).statusCode).toBe(401);
    const res = await get("/api/v1/status/details");
    expect(res.statusCode).toBe(200);
    const byId = Object.fromEntries(
      res.json().checks.map((c: { id: string; level: string }) => [c.id, c.level]),
    );
    expect(byId).toMatchObject({ ai: "off", bank: "off", "server-update": "ok" });
  });

  it("tests an Ollama on another machine, including one behind a token", async () => {
    const denied = (await post("/api/v1/ai/test", { provider: "ollama", baseUrl: base })).json();
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/not authorized/i);

    const ok = (await post("/api/v1/ai/test", { provider: "ollama", baseUrl: base, apiKey: "let-me-in" })).json();
    expect(ok).toMatchObject({ ok: true, models: ["llama3.2:3b", "qwen2.5:7b"] });
  });

  it("tests an OpenAI-compatible local server and explains a wrong path", async () => {
    const ok = (await post("/api/v1/ai/test", { provider: "local_openai", baseUrl: `${base}/v1` })).json();
    expect(ok).toMatchObject({ ok: true, models: ["local-model"] });

    const wrongPath = (await post("/api/v1/ai/test", { provider: "local_openai", baseUrl: `${base}/nope` })).json();
    expect(wrongPath.ok).toBe(false);
    expect(wrongPath.hint).toMatch(/\/v1/);
  });

  it("explains that localhost is the Vault container when nothing answers there", async () => {
    // A port that was just freed, so nothing is listening on it.
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));

    const res = (await post("/api/v1/ai/test", { provider: "ollama", baseUrl: `http://127.0.0.1:${port}` })).json();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/own container/);
    expect(res.hint).toContain(`host.docker.internal:${port}`);
  });

  it("refuses a local provider without an address, and never falls back to the cloud", async () => {
    const res = (await post("/api/v1/ai/test", { provider: "local_openai", baseUrl: "" })).json();
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toMatch(/address/);

    const save = await post("/api/v1/ai/settings", { enabled: true, provider: "local_openai", model: "x", baseUrl: "" });
    expect(save.statusCode).toBe(400);
  });

  it("saves a separate AI server and shows its status, with reasons when it's down", async () => {
    const saved = await post("/api/v1/ai/settings", {
      enabled: true,
      provider: "local_openai",
      model: "local-model",
      baseUrl: `${base}/v1`,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ reachable: true, baseUrl: `${base}/v1` });

    let detail = (await get("/api/v1/status/details")).json();
    expect(detail.checks.find((c: { id: string }) => c.id === "ai").level).toBe("ok");

    await post("/api/v1/ai/settings", { enabled: true, provider: "ollama", model: "x", baseUrl: base });
    detail = (await get("/api/v1/status/details")).json();
    const ai = detail.checks.find((c: { id: string }) => c.id === "ai");
    expect(ai.level).toBe("warn");
    expect(ai.detail).toMatch(/not authorized/i);
  });

  it("only lets the owner run connection tests", async () => {
    await post("/api/v1/members", { displayName: "Kid", email: "kid@sam.home", tempPassword: "temporary-pass-1" });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "kid@sam.home", password: "temporary-pass-1", deviceName: "T", platform: "linux" },
    });
    const member = { authorization: `Bearer ${login.json().accessToken}` };
    const res = await post("/api/v1/ai/test", { provider: "ollama", baseUrl: base }, member);
    expect(res.statusCode).toBe(403);
  });
});
