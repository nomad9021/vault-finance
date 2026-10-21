import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp as buildApp } from "./helpers/test-app.js";
import { loadConfig } from "../src/config.js";

/**
 * The assistant proposing changes (category tree, rules, budgets, settings):
 * approve / reject / auto mode, and its append-only memory file.
 */

const PG_PORT = 55500;
const OLLAMA_PORT = 55501;

let pg: EmbeddedPostgres;
let app: FastifyInstance;
let server: Server;
let dataDir: string;
let pgDir: string;
let auth: { authorization: string };
let userId: string;

/** What the mock model says next, and the system prompt it was last given. */
let nextReply = "";
let lastSystemPrompt = "";

function mockOllama() {
  return createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ models: [{ name: "llama3.1:8b" }] }));
    }
    if (req.url === "/api/chat") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body) as { messages: { role: string; content: string }[] };
        lastSystemPrompt = parsed.messages.find((m) => m.role === "system")?.content ?? "";
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        // Split mid-tag to prove blocks are reassembled from the whole reply.
        const mid = Math.floor(nextReply.length / 2);
        for (const t of [nextReply.slice(0, mid), nextReply.slice(mid)]) {
          res.write(JSON.stringify({ message: { content: t }, done: false }) + "\n");
        }
        res.end(JSON.stringify({ message: { content: "" }, done: true }) + "\n");
      });
      return;
    }
    res.writeHead(404).end();
  });
}

function lines(payload: string): Array<Record<string, unknown>> {
  return payload.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

async function chat(message: string, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/ai/chat",
    headers: auth,
    payload: { message, ...extra },
  });
  expect(res.statusCode).toBe(200);
  return lines(res.payload);
}

async function categoryNames(): Promise<string[]> {
  const res = await app.inject({ method: "GET", url: "/api/v1/categories", headers: auth });
  return res.json().categories.map((c: { name: string }) => c.name);
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "vault-aiact-data-"));
  pgDir = mkdtempSync(path.join(tmpdir(), "vault-aiact-pg-"));
  server = mockOllama();
  await new Promise<void>((r) => server.listen(OLLAMA_PORT, "127.0.0.1", () => r()));

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
    } as NodeJS.ProcessEnv),
  });
  await app.inject({
    method: "POST",
    url: "/api/v1/setup/complete",
    payload: { ownerEmail: "riley@rivera.home", ownerPassword: "correct-horse-battery", ownerDisplayName: "Riley Rivera" },
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: "riley@rivera.home", password: "correct-horse-battery", deviceName: "Test", platform: "linux" },
  });
  auth = { authorization: `Bearer ${login.json().accessToken}` };
  userId = (await app.inject({ method: "GET", url: "/api/v1/me", headers: auth })).json().id;
  await app.inject({
    method: "POST",
    url: "/api/v1/ai/settings",
    headers: auth,
    payload: { enabled: true, provider: "ollama", model: "llama3.1:8b", baseUrl: `http://127.0.0.1:${OLLAMA_PORT}` },
  });
});

afterAll(async () => {
  await app?.close();
  await pg?.stop();
  await new Promise((r) => server.close(r));
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(pgDir, { recursive: true, force: true });
});

describe("AI-proposed changes", () => {
  it("teaches the model the category tree and the action syntax", async () => {
    nextReply = "Sure.";
    await chat("hi");
    expect(lastSystemPrompt).toContain("CATEGORY TREE:");
    expect(lastSystemPrompt).toContain("Groceries");
    expect(lastSystemPrompt).toContain("<vault-action>");
  });

  it("proposes a change and waits for approval", async () => {
    nextReply =
      'I\'ll add a Pets category.\n<vault-action>{"type":"create_category","name":"Pets"}</vault-action>';
    const out = await chat("add a pets category");
    const visible = out.filter((l) => "token" in l).map((l) => l["token"]).join("");
    expect(visible).toContain("<vault-action>"); // raw stream; the app hides blocks
    const actions = out.find((l) => "actions" in l)!["actions"] as Array<Record<string, unknown>>;
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ status: "pending", client: false, summary: 'Add category "Pets"' });
    expect(await categoryNames()).not.toContain("Pets"); // nothing happened yet

    const approve = await app.inject({
      method: "POST",
      url: `/api/v1/ai/actions/${actions[0]!["id"]}/approve`,
      headers: auth,
      payload: {},
    });
    expect(approve.json()).toMatchObject({ status: "applied" });
    expect(await categoryNames()).toContain("Pets");

    // Can't approve twice.
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/ai/actions/${actions[0]!["id"]}/approve`,
      headers: auth,
      payload: {},
    });
    expect(again.statusCode).toBe(409);

    // The saved message has the block stripped and carries the action.
    const conversationId = out.at(-1)!["conversationId"] as string;
    const detail = (await app.inject({ method: "GET", url: `/api/v1/ai/conversations/${conversationId}`, headers: auth })).json();
    const reply = detail.messages.at(-1);
    expect(reply.content).toBe("I'll add a Pets category.");
    expect(reply.actions[0]).toMatchObject({ status: "applied" });
  });

  it("rejecting leaves things alone", async () => {
    nextReply = '<vault-action>{"type":"rename_category","category":"Pets","newName":"Animals"}</vault-action>';
    const out = await chat("rename pets");
    const [action] = out.find((l) => "actions" in l)!["actions"] as Array<{ id: string }>;
    const res = await app.inject({ method: "POST", url: `/api/v1/ai/actions/${action!.id}/reject`, headers: auth, payload: {} });
    expect(res.json()).toMatchObject({ status: "rejected" });
    expect(await categoryNames()).toContain("Pets");
  });

  it("auto mode applies server changes at once, drops ones the rule check rejects, leaves app-side ones pending", async () => {
    nextReply = [
      '<vault-action>{"type":"create_category","name":"Vet","parent":"Pets"}</vault-action>',
      '<vault-action>{"type":"set_budget","category":"Vet","amount":75}</vault-action>',
      '<vault-action>{"type":"create_rule","keyword":"BANFIELD","category":"Vet"}</vault-action>',
      '<vault-action>{"type":"rename_category","category":"Nope","newName":"X"}</vault-action>',
      '<vault-action>{"type":"set_theme","theme":"dark"}</vault-action>',
      '<vault-action>{"type":"not_a_thing"}</vault-action>',
    ].join("\n");
    const out = await chat("set up vet tracking", { autoApply: true });
    const actions = out.find((l) => "actions" in l)!["actions"] as Array<Record<string, unknown>>;
    // The rename of a missing category never becomes a card (the mock model
    // repeats itself when asked to fix it, so nothing is added twice either).
    expect(actions.map((a) => a["status"])).toEqual(["applied", "applied", "applied", "pending"]);
    expect(actions[3]).toMatchObject({ client: true });

    const budgets = (await app.inject({ method: "GET", url: "/api/v1/budgets", headers: auth })).json();
    expect(budgets.budgets.some((b: { amountCents: number }) => b.amountCents === 7_500)).toBe(true);

    // The app reports how its own change went.
    const reported = await app.inject({
      method: "POST",
      url: `/api/v1/ai/actions/${actions[3]!["id"]}/result`,
      headers: auth,
      payload: { status: "applied" },
    });
    expect(reported.json()).toMatchObject({ status: "applied" });
  });

  it("remembers notes in a file that outlives deleted chats", async () => {
    nextReply = "Noted.\n<vault-remember>Wants to pay off the car loan by 2028</vault-remember>";
    const out = await chat("my goal is to pay off the car by 2028");
    expect(out.find((l) => "remembered" in l)).toMatchObject({ remembered: ["Wants to pay off the car loan by 2028"] });

    const file = path.join(dataDir, "ai-memory", `${userId}.jsonl`);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).not.toContain("car loan"); // encrypted at rest

    // Delete every chat — the memory stays and still reaches the model.
    const list = (await app.inject({ method: "GET", url: "/api/v1/ai/conversations", headers: auth })).json();
    for (const c of list.conversations) {
      await app.inject({ method: "DELETE", url: `/api/v1/ai/conversations/${c.id}`, headers: auth });
    }
    const memory = (await app.inject({ method: "GET", url: "/api/v1/ai/memory", headers: auth })).json();
    expect(memory.notes.map((n: { text: string }) => n.text)).toEqual(["Wants to pay off the car loan by 2028"]);

    nextReply = "Hello again.";
    await chat("hi");
    expect(lastSystemPrompt).toContain("Wants to pay off the car loan by 2028");
  });
});
