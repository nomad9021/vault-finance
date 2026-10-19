import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { FastifyInstance } from "fastify";
import { generate } from "selfsigned";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp as buildApp } from "./helpers/test-app.js";
import { loadConfig } from "../src/config.js";
import { certFingerprint } from "../src/tls.js";

/**
 * A separate AI server in a Proxmox VM: the assistant shows whether it's on,
 * any member can start it, and Vault's AI calls carry a queue priority for
 * the AI server's gateway.
 */
describe("AI server power and priority", () => {
  const PG_PORT = 55490;
  const TOKEN = "vault@pve!ai-power=11111111-2222-3333-4444-555555555555";
  let pg: EmbeddedPostgres;
  let app: FastifyInstance;
  let badPinApp: FastifyInstance;
  let owner: { authorization: string };
  let proxmox: HttpsServer;
  let gateway: Server;
  let gatewayBase: string;

  let vm = "stopped";
  let startCalls = 0;
  let gatewayUp = false;
  const chatCalls: Array<{ priority?: string; auth?: string }> = [];

  const get = (url: string, a = app) => a.inject({ method: "GET", url, headers: owner });
  const post = (url: string, payload?: unknown, a = app) =>
    a.inject({ method: "POST", url, headers: owner, ...(payload === undefined ? {} : { payload }) });

  beforeAll(async () => {
    const pems = await generate([{ name: "commonName", value: "pve3" }], {
      notAfterDate: new Date(Date.now() + 86_400_000),
      keySize: 2048,
      algorithm: "sha256",
    });
    proxmox = createHttpsServer({ key: pems.private, cert: pems.cert }, (req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization !== `PVEAPIToken=${TOKEN}`) {
        res.statusCode = 401;
        return res.end("{}");
      }
      if (req.method === "GET" && req.url === "/api2/json/nodes/pve3/qemu/105/status/current") {
        return res.end(JSON.stringify({ data: { status: vm } }));
      }
      if (req.method === "POST" && req.url === "/api2/json/nodes/pve3/qemu/105/status/start") {
        startCalls++;
        vm = "running";
        return res.end(JSON.stringify({ data: "UPID:pve3:start" }));
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((r) => proxmox.listen(0, "127.0.0.1", r));
    const proxmoxUrl = `https://127.0.0.1:${(proxmox.address() as AddressInfo).port}`;

    gateway = createServer((req, res) => {
      if (!gatewayUp) {
        res.statusCode = 503;
        return res.end();
      }
      res.setHeader("content-type", "application/json");
      if (req.url === "/health") return res.end(JSON.stringify({ ok: true, idleSeconds: 0, active: 1, waiting: 2 }));
      if (req.url === "/v1/models") {
        return res.end(JSON.stringify({ object: "list", data: [{ id: "llama3.2:3b", object: "model", created: 0, owned_by: "x" }] }));
      }
      if (req.url === "/v1/chat/completions") {
        chatCalls.push({
          priority: req.headers["x-priority"] as string | undefined,
          auth: req.headers.authorization,
        });
        res.setHeader("content-type", "text/event-stream");
        const chunk = { id: "1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] };
        return res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
    gatewayBase = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;

    const pgDir = mkdtempSync(path.join(tmpdir(), "vault-aihost-pg-"));
    pg = new EmbeddedPostgres({ databaseDir: pgDir, user: "vault", password: "vault", port: PG_PORT, persistent: false });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("vault");

    // Shared so both apps accept the same sign-in and read the same stored key.
    const dataDir = mkdtempSync(path.join(tmpdir(), "vault-aihost-data-"));
    const env = (fingerprint: string) =>
      loadConfig({
        DATABASE_URL: `postgres://vault:vault@localhost:${PG_PORT}/vault`,
        VAULT_TLS: "off",
        VAULT_DATA_DIR: dataDir,
        LOG_LEVEL: "error",
        UPDATE_CHECK_ENABLED: "false",
        AI_HOST_PROXMOX_URL: proxmoxUrl,
        AI_HOST_PROXMOX_NODE: "pve3",
        AI_HOST_VMID: "105",
        AI_HOST_PROXMOX_TOKEN: TOKEN,
        AI_HOST_PROXMOX_FINGERPRINT: fingerprint,
      } as NodeJS.ProcessEnv);
    app = await buildApp({ config: env(certFingerprint(pems.cert)) });
    badPinApp = await buildApp({ config: env("AA:".repeat(31) + "AA") });

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
    await badPinApp?.close();
    await pg?.stop();
    proxmox?.close();
    gateway?.close();
  });

  it("has nothing to report while AI is off", async () => {
    const res = await get("/api/v1/ai/host");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ applies: false, canStart: true });
  });

  it("shows a stopped AI server as off, then starting once someone presses Start", async () => {
    const saved = await post("/api/v1/ai/settings", {
      enabled: true,
      provider: "local_openai",
      model: "llama3.2:3b",
      baseUrl: `${gatewayBase}/v1`,
      apiKey: "gateway-key-0123456789",
    });
    expect(saved.statusCode).toBe(200);

    expect((await get("/api/v1/ai/host")).json()).toMatchObject({ applies: true, power: "off", canStart: true });

    const started = await post("/api/v1/ai/host/start");
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ power: "starting" });
    expect(startCalls).toBe(1);

    // Pressing Start again while it boots doesn't send a second start.
    await post("/api/v1/ai/host/start");
    expect(startCalls).toBe(1);
  });

  it("reports on, with the gateway's queue, once the AI server answers", async () => {
    gatewayUp = true;
    expect((await get("/api/v1/ai/host")).json()).toEqual({
      applies: true,
      power: "on",
      canStart: true,
      queue: { active: 1, waiting: 2 },
    });
  });

  it("sends chat to the gateway as interactive, with the gateway key", async () => {
    const res = await post("/api/v1/ai/chat", { message: "How am I doing?" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"token":"Hi"');
    expect(chatCalls.at(-1)).toEqual({ priority: "interactive", auth: "Bearer gateway-key-0123456789" });
  });

  it("refuses to talk to a Proxmox whose certificate doesn't match the pin", async () => {
    gatewayUp = false;
    vm = "stopped";
    const before = startCalls;
    const status = (await get("/api/v1/ai/host", badPinApp)).json();
    expect(status).toMatchObject({ power: "unknown" });
    expect(status.message).toMatch(/fingerprint/i);

    const start = await post("/api/v1/ai/host/start", undefined, badPinApp);
    expect(start.statusCode).toBe(502);
    expect(start.json().error?.code ?? start.json().code).toBe("AI_HOST_START_FAILED");
    expect(startCalls).toBe(before);
  });
});
