import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

/**
 * AI assistant, multi-provider. Off by default; the owner configures a
 * provider in Settings. Streaming chat proxied through the server (ADR-0005)
 * is exercised against a mock Ollama, a mock OpenAI, and a mock Anthropic.
 */

const PG_PORT = 55438;
const OLLAMA_PORT = 55439;
const OPENAI_PORT = 55440;
const ANTHROPIC_PORT = 55441;

let pg: EmbeddedPostgres;
let app: FastifyInstance;
const servers: Server[] = [];
let dataDir: string;
let pgDir: string;
let auth: { authorization: string };

let ollamaUp = true;

function listen(server: Server, port: number): Promise<Server> {
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve(server)),
  );
}

/** Mock Ollama: /api/tags + streaming /api/chat (NDJSON). */
function mockOllama() {
  return createServer((req, res) => {
    if (!ollamaUp) return req.socket.destroy();
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ models: [{ name: "llama3.1:8b" }] }));
    }
    if (req.url === "/api/chat") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const streaming = JSON.parse(body).stream === true;
        if (!streaming) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ message: { content: "ollama summary" }, done: true }));
        }
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        for (const t of ["From ", "Ollama: ", "$132 ", "on groceries."]) {
          res.write(JSON.stringify({ message: { content: t }, done: false }) + "\n");
        }
        res.end(JSON.stringify({ message: { content: "" }, done: true }) + "\n");
      });
      return;
    }
    res.writeHead(404).end();
  });
}

/** Mock OpenAI: /v1/models + /v1/chat/completions (SSE + non-stream). */
function mockOpenAI() {
  return createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({ object: "list", data: [{ id: "gpt-4o-mini", object: "model" }] }),
      );
    }
    if (req.url === "/v1/chat/completions") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (JSON.parse(body).stream !== true) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(
            JSON.stringify({ choices: [{ message: { role: "assistant", content: "openai summary" } }] }),
          );
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const t of ["From ", "OpenAI: ", "spending ", "looks fine."]) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
      return;
    }
    res.writeHead(404).end();
  });
}

/** Mock Anthropic: /v1/models + /v1/messages (SSE + non-stream). */
function mockAnthropic() {
  return createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          data: [{ type: "model", id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }],
          has_more: false,
          first_id: null,
          last_id: null,
        }),
      );
    }
    if (req.url === "/v1/messages") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (JSON.parse(body).stream !== true) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(
            JSON.stringify({
              id: "msg_1",
              type: "message",
              role: "assistant",
              model: "claude-sonnet-5",
              content: [{ type: "text", text: "anthropic summary" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          );
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (event: string, data: unknown) =>
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        send("message_start", {
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-5",
            content: [],
            stop_reason: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        });
        send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        for (const t of ["From ", "Claude: ", "you saved ", "$1,013."]) {
          send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } });
        }
        send("content_block_stop", { type: "content_block_stop", index: 0 });
        send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } });
        send("message_stop", { type: "message_stop" });
        res.end();
      });
      return;
    }
    res.writeHead(404).end();
  });
}

function parseNdjson(payload: string): Array<Record<string, unknown>> {
  return payload.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

async function configure(body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/v1/ai/settings", headers: auth, payload: body });
}

beforeAll(async () => {
  // The OpenAI/Anthropic SDKs read these to reach the mock servers.
  process.env["OPENAI_BASE_URL"] = `http://127.0.0.1:${OPENAI_PORT}/v1`;
  process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${ANTHROPIC_PORT}`;

  dataDir = mkdtempSync(path.join(tmpdir(), "vault-m4-data-"));
  pgDir = mkdtempSync(path.join(tmpdir(), "vault-m4-pg-"));
  await listen(mockOllama(), OLLAMA_PORT);
  await listen(mockOpenAI(), OPENAI_PORT);
  await listen(mockAnthropic(), ANTHROPIC_PORT);

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
    } as NodeJS.ProcessEnv),
  });

  await app.inject({
    method: "POST",
    url: "/api/v1/setup/complete",
    payload: {
      ownerEmail: "maya@chen.home",
      ownerPassword: "correct-horse-battery",
      ownerDisplayName: "Maya Chen",
    },
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: {
      email: "maya@chen.home",
      password: "correct-horse-battery",
      deviceName: "Test",
      platform: "linux",
    },
  });
  auth = { authorization: `Bearer ${login.json().accessToken}` };

  // Real data for the financial context.
  const account = await app.inject({
    method: "POST",
    url: "/api/v1/accounts",
    headers: auth,
    payload: { name: "Everyday Checking", type: "checking", balanceCents: 250_000 },
  });
  const cats = await app.inject({ method: "GET", url: "/api/v1/categories", headers: auth });
  const groceries = cats.json().categories.find((c: { name: string }) => c.name === "Groceries");
  await app.inject({
    method: "POST",
    url: "/api/v1/transactions",
    headers: auth,
    payload: {
      accountId: account.json().id,
      categoryId: groceries.id,
      postedAt: new Date().toISOString().slice(0, 10),
      amountCents: -13_200,
      merchantName: "Fresh Market",
    },
  });
});

afterAll(async () => {
  await app?.close();
  await pg?.stop();
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(pgDir, { recursive: true, force: true });
  delete process.env["OPENAI_BASE_URL"];
  delete process.env["ANTHROPIC_BASE_URL"];
});

describe("off by default", () => {
  it("reports disabled + unconfigured on a fresh server", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/ai/status", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      enabled: false,
      provider: "ollama",
      reachable: false,
      hasApiKey: false,
    });
  });

  it("refuses chat with AI_DISABLED while off", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/chat",
      headers: auth,
      payload: { message: "hi" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("AI_DISABLED");
  });
});

describe("settings", () => {
  it("owner-only; rejects an enabled cloud provider with no key at the schema layer only via missing key", async () => {
    // Enabling OpenAI without a key: saved, but reports not-configured.
    const res = await configure({ enabled: true, provider: "openai", model: "gpt-4o-mini" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, provider: "openai", configured: false, hasApiKey: false });

    const chat = await app.inject({
      method: "POST",
      url: "/api/v1/ai/chat",
      headers: auth,
      payload: { message: "hi" },
    });
    expect(chat.statusCode).toBe(503);
    expect(chat.json().error.code).toBe("AI_UNAVAILABLE");
  });

  it("never returns the API key; omitting it on update keeps it", async () => {
    await configure({ enabled: true, provider: "openai", model: "gpt-4o-mini", apiKey: "sk-secret" });
    const status = await app.inject({ method: "GET", url: "/api/v1/ai/status", headers: auth });
    expect(status.json()).toMatchObject({ configured: true, hasApiKey: true });
    expect(JSON.stringify(status.json())).not.toContain("sk-secret");

    // Update the model without resending the key — key must persist.
    const upd = await configure({ enabled: true, provider: "openai", model: "gpt-4o" });
    expect(upd.json()).toMatchObject({ hasApiKey: true, model: "gpt-4o" });
  });
});

describe("streaming chat per provider", () => {
  it("streams via Ollama", async () => {
    await configure({ enabled: true, provider: "ollama", model: "llama3.1:8b", baseUrl: `http://127.0.0.1:${OLLAMA_PORT}` });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/chat",
      headers: auth,
      payload: { message: "How much on groceries?" },
    });
    expect(res.statusCode).toBe(200);
    const tokens = parseNdjson(res.payload).filter((l) => "token" in l).map((l) => l["token"]);
    expect(tokens.join("")).toBe("From Ollama: $132 on groceries.");
  });

  it("streams via OpenAI", async () => {
    await configure({ enabled: true, provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test" });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/chat",
      headers: auth,
      payload: { message: "How's my spending?" },
    });
    expect(res.statusCode).toBe(200);
    const lines = parseNdjson(res.payload);
    expect(lines.filter((l) => "token" in l).map((l) => l["token"]).join("")).toBe(
      "From OpenAI: spending looks fine.",
    );
    expect(lines.at(-1)).toMatchObject({ done: true });
  });

  it("streams via Anthropic", async () => {
    await configure({ enabled: true, provider: "anthropic", model: "claude-sonnet-5", apiKey: "sk-ant" });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/chat",
      headers: auth,
      payload: { message: "Did I save money?" },
    });
    expect(res.statusCode).toBe(200);
    const tokens = parseNdjson(res.payload).filter((l) => "token" in l).map((l) => l["token"]);
    expect(tokens.join("")).toBe("From Claude: you saved $1,013.");
  });

  it("persists the exchange and lists the conversation", async () => {
    const list = await app.inject({ method: "GET", url: "/api/v1/ai/conversations", headers: auth });
    expect(list.json().conversations.length).toBeGreaterThanOrEqual(1);
  });

  it("returns AI_UNAVAILABLE when Ollama is down, without orphaning a conversation", async () => {
    await configure({ enabled: true, provider: "ollama", model: "llama3.1:8b", baseUrl: `http://127.0.0.1:${OLLAMA_PORT}` });
    const before = (await app.inject({ method: "GET", url: "/api/v1/ai/conversations", headers: auth })).json()
      .conversations.length;
    ollamaUp = false;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/chat",
      headers: auth,
      payload: { message: "still there?" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("AI_UNAVAILABLE");
    ollamaUp = true;
    const after = (await app.inject({ method: "GET", url: "/api/v1/ai/conversations", headers: auth })).json()
      .conversations.length;
    expect(after).toBe(before);
  });

  it("keeps non-AI features working regardless of AI state", async () => {
    ollamaUp = false;
    const accounts = await app.inject({ method: "GET", url: "/api/v1/accounts", headers: auth });
    expect(accounts.statusCode).toBe(200);
    ollamaUp = true;
  });
});
