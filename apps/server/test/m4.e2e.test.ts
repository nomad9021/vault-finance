import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

/** M4: AI status/settings, conversations, NDJSON streaming chat vs mock Ollama. */

const PG_PORT = 55437;
const OLLAMA_PORT = 55438;

let pg: EmbeddedPostgres;
let app: FastifyInstance;
let mockOllama: Server;
let dataDir: string;
let pgDir: string;
let auth: { authorization: string };

/** Captured request bodies sent to the mock's /api/chat. */
const chatCalls: Array<{
  model: string;
  messages: Array<{ role: string; content: string }>;
}> = [];
let mockUp = true;

function startMockOllama(): Promise<Server> {
  const server = createServer((req, res) => {
    if (!mockUp) {
      req.socket.destroy();
      return;
    }
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "test-model:tiny" }] }));
      return;
    }
    if (req.url === "/api/chat") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        chatCalls.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        const tokens = ["You ", "spent ", "$132 ", "on ", "groceries."];
        for (const t of tokens) {
          res.write(JSON.stringify({ message: { content: t }, done: false }) + "\n");
        }
        res.end(JSON.stringify({ message: { content: "" }, done: true }) + "\n");
      });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(OLLAMA_PORT, "127.0.0.1", () => resolve(server)));
}

function parseNdjson(payload: string): Array<Record<string, unknown>> {
  return payload
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "vault-m4-data-"));
  pgDir = mkdtempSync(path.join(tmpdir(), "vault-m4-pg-"));
  mockOllama = await startMockOllama();

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
      aiConfig: {
        ollamaHost: "127.0.0.1",
        ollamaPort: OLLAMA_PORT,
        modelName: "test-model:tiny",
        enabled: true,
      },
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
  const groceries = cats
    .json()
    .categories.find((c: { name: string }) => c.name === "Groceries");
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
  await new Promise((r) => mockOllama.close(r));
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(pgDir, { recursive: true, force: true });
});

describe("ai status & settings", () => {
  it("reports reachable with available models", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/ai/status", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      enabled: true,
      reachable: true,
      model: "test-model:tiny",
      availableModels: ["test-model:tiny"],
    });
  });

  it("reports unreachable when Ollama is down, without breaking anything else", async () => {
    mockUp = false;
    const status = await app.inject({ method: "GET", url: "/api/v1/ai/status", headers: auth });
    expect(status.json().reachable).toBe(false);

    // Graceful degradation: non-AI endpoints unaffected.
    const accounts = await app.inject({ method: "GET", url: "/api/v1/accounts", headers: auth });
    expect(accounts.statusCode).toBe(200);
    mockUp = true;
  });

  it("updates settings (owner) and returns fresh status", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/settings",
      headers: auth,
      payload: {
        ollamaHost: "127.0.0.1",
        ollamaPort: OLLAMA_PORT,
        modelName: "test-model:tiny",
        enabled: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reachable).toBe(true);
  });
});

describe("streaming chat", () => {
  let conversationId: string;

  it("streams NDJSON tokens and persists the exchange", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/chat",
      headers: auth,
      payload: { message: "How much did I spend on groceries this month?" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/x-ndjson");

    const lines = parseNdjson(res.payload);
    const tokens = lines.filter((l) => "token" in l).map((l) => l["token"]);
    expect(tokens.join("")).toBe("You spent $132 on groceries.");
    const done = lines.at(-1);
    expect(done).toMatchObject({ done: true });
    conversationId = done!["conversationId"] as string;

    // The model saw the real financial context and the user message.
    const call = chatCalls.at(-1)!;
    expect(call.model).toBe("test-model:tiny");
    const system = call.messages[0]!;
    expect(system.role).toBe("system");
    expect(system.content).toContain("Everyday Checking");
    expect(system.content).toContain("Groceries: $132.00");
    expect(call.messages.at(-1)).toMatchObject({
      role: "user",
      content: "How much did I spend on groceries this month?",
    });
  });

  it("continues a conversation with history", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/chat",
      headers: auth,
      payload: { conversationId, message: "Is that a lot?" },
    });
    expect(res.statusCode).toBe(200);
    const lines = parseNdjson(res.payload);
    expect(lines.at(-1)).toMatchObject({ done: true, conversationId });

    // History sent to the model includes the prior assistant answer.
    const call = chatCalls.at(-1)!;
    const roles = call.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "user"]);
  });

  it("lists and fetches the persisted conversation", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/ai/conversations",
      headers: auth,
    });
    expect(list.json().conversations).toHaveLength(1);
    expect(list.json().conversations[0].title).toContain("How much did I spend");

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/ai/conversations/${conversationId}`,
      headers: auth,
    });
    const messages = detail.json().messages;
    expect(messages).toHaveLength(4); // user, assistant, user, assistant
    expect(messages[1].content).toBe("You spent $132 on groceries.");
  });

  it("returns clean JSON 503 when Ollama is down (no stream, no orphan rows)", async () => {
    mockUp = false;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/chat",
      headers: auth,
      payload: { message: "hello?" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("AI_UNAVAILABLE");
    mockUp = true;

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/ai/conversations",
      headers: auth,
    });
    expect(list.json().conversations).toHaveLength(1); // nothing half-created
  });

  it("returns AI_DISABLED when the assistant is turned off", async () => {
    await app.inject({
      method: "POST",
      url: "/api/v1/ai/settings",
      headers: auth,
      payload: {
        ollamaHost: "127.0.0.1",
        ollamaPort: OLLAMA_PORT,
        modelName: "test-model:tiny",
        enabled: false,
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/chat",
      headers: auth,
      payload: { message: "hello?" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("AI_DISABLED");

    // Re-enable and delete the conversation.
    await app.inject({
      method: "POST",
      url: "/api/v1/ai/settings",
      headers: auth,
      payload: {
        ollamaHost: "127.0.0.1",
        ollamaPort: OLLAMA_PORT,
        modelName: "test-model:tiny",
        enabled: true,
      },
    });
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/ai/conversations/${conversationId}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(204);
  });
});
