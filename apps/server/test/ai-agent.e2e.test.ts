import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp as buildApp } from "./helpers/test-app.js";
import { loadConfig } from "../src/config.js";

/**
 * The assistant as an agent: it looks things up (<vault-query>), the server
 * answers and the model continues, then it proposes changes that organize
 * transactions, the category tree's order and budgets — what the Sankeys
 * are drawn from. Plain text both ways, so any model can do it.
 */

const PG_PORT = 55510;
const OLLAMA_PORT = 55511;

let pg: EmbeddedPostgres;
let app: FastifyInstance;
let server: Server;
let dataDir: string;
let pgDir: string;
let auth: { authorization: string };

/** Scripted replies, one per model call, and every conversation the model was sent. */
let replies: string[] = [];
const calls: Array<Array<{ role: string; content: string }>> = [];

function mockOllama() {
  return createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ models: [{ name: "any-model" }] }));
    }
    if (req.url === "/api/chat") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        calls.push((JSON.parse(body) as { messages: Array<{ role: string; content: string }> }).messages);
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(JSON.stringify({ message: { content: replies.shift() ?? "Done." }, done: false }) + "\n");
        res.end(JSON.stringify({ message: { content: "" }, done: true }) + "\n");
      });
      return;
    }
    res.writeHead(404).end();
  });
}

const lines = (payload: string) =>
  payload.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);

const api = async (method: "GET" | "POST", url: string, payload?: unknown) => {
  const res = await app.inject({ method, url: `/api/v1${url}`, headers: auth, ...(payload ? { payload: payload as object } : {}) });
  expect(res.statusCode, res.payload).toBeLessThan(300);
  return res.json();
};

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "vault-agent-data-"));
  pgDir = mkdtempSync(path.join(tmpdir(), "vault-agent-pg-"));
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
    payload: { ownerEmail: "alex@lakeside.home", ownerPassword: "correct-horse-battery", ownerDisplayName: "Alex" },
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: "alex@lakeside.home", password: "correct-horse-battery", deviceName: "Test", platform: "linux" },
  });
  auth = { authorization: `Bearer ${login.json().accessToken}` };
  await api("POST", "/ai/settings", { enabled: true, provider: "ollama", model: "any-model", baseUrl: `http://127.0.0.1:${OLLAMA_PORT}` });

  const account = await api("POST", "/accounts", { name: "Checking", type: "checking", balanceCents: 500_000 });
  const today = new Date().toISOString().slice(0, 10);
  for (const [merchant, cents] of [["Blue Kettle 4411", -650], ["Blue Kettle 4411", -720], ["Zephyr Gym Club", -4500]] as const) {
    await api("POST", "/transactions", { accountId: account.id, postedAt: today, amountCents: cents, merchantName: merchant, categoryId: null });
  }
});

afterAll(async () => {
  await app?.close();
  await pg?.stop();
  await new Promise((r) => server.close(r));
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(pgDir, { recursive: true, force: true });
});

describe("finance agent", () => {
  it("looks things up, continues with the results, then proposes organizing changes", async () => {
    calls.length = 0;
    replies = [
      'Let me look at your merchants.\n<vault-query>{"type":"merchants","months":3,"uncategorizedOnly":true}</vault-query>',
      'Blue Kettle is coffee.\n<vault-action>{"type":"recategorize","merchant":"blue kettle","category":"Dining Out","from":"Uncategorized"}</vault-action>\n' +
        '<vault-action>{"type":"reorder_categories","parent":null,"order":["Groceries","Dining Out"]}</vault-action>',
    ];
    const res = await app.inject({ method: "POST", url: "/api/v1/ai/chat", headers: auth, payload: { message: "Organize my finances", autoApply: true } });
    expect(res.statusCode).toBe(200);
    const out = lines(res.payload);

    // Two model calls: the second carries the look-up results.
    expect(calls).toHaveLength(2);
    const results = calls[1]!.at(-1)!;
    expect(results.role).toBe("user");
    expect(results.content).toContain("LOOK-UP RESULTS");
    expect(results.content).toMatch(/Blue Kettle 4411 \| 2× \| out \$13\.70 \| Uncategorized/);
    expect(results.content).toContain("Zephyr Gym Club");
    expect(out.find((l) => "status" in l)?.["status"]).toBe("Checking your merchants…");

    // The guide teaches the look-ups and the new changes.
    expect(calls[0]![0]!.content).toContain("<vault-query>");
    expect(calls[0]![0]!.content).toContain("reorder_categories");
    expect(calls[0]![0]!.content).toContain("Uncategorized transactions (all time): 3.");

    // Auto mode applied both changes.
    const actions = out.find((l) => "actions" in l)!["actions"] as Array<{ status: string; error: string | null }>;
    expect(actions.map((a) => a.status)).toEqual(["applied", "applied"]);
    const dining = (await api("GET", "/categories")).categories.find((c: { name: string }) => c.name === "Dining Out");
    const kettle = (await api("GET", "/transactions?search=blue")).transactions;
    expect(kettle).toHaveLength(2);
    expect(kettle.every((t: { categoryId: string }) => t.categoryId === dining.id)).toBe(true);
    const gym = (await api("GET", "/transactions?search=zephyr")).transactions;
    expect(gym[0].categoryId).toBeNull();

    const top = (await api("GET", "/categories")).categories.filter(
      (c: { parentCategoryId: string | null; kind: string }) => c.parentCategoryId === null && c.kind === "expense",
    );
    expect(top.slice(0, 2).map((c: { name: string }) => c.name)).toEqual(["Groceries", "Dining Out"]);

    // Look-up blocks never reach the saved conversation.
    const convoId = out.find((l) => "done" in l)!["conversationId"] as string;
    const saved = await api("GET", `/ai/conversations/${convoId}`);
    expect(saved.messages.at(-1).content).not.toContain("vault-query");
    expect(saved.messages.at(-1).content).toContain("Blue Kettle is coffee.");
  });

  it("stops after a few rounds even if the model keeps asking", async () => {
    calls.length = 0;
    const ask = '<vault-query>{"type":"category_totals","months":2}</vault-query>';
    replies = [ask, ask, ask, ask, ask, ask];
    const res = await app.inject({ method: "POST", url: "/api/v1/ai/chat", headers: auth, payload: { message: "loop" } });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(4);
    expect(calls[3]!.at(-1)!.content).toContain("without more look-ups");
    expect(calls[1]!.at(-1)!.content).toContain("CATEGORY TOTALS");
    // Repeats get pointed back at the results they already have.
    expect(calls[2]!.at(-1)!.content).toContain("You already have the results");
    expect(calls[2]!.at(-1)!.content).not.toContain("CATEGORY TOTALS");
  });

  it("tells the model when a look-up is malformed instead of failing", async () => {
    calls.length = 0;
    replies = ['<vault-query>{"type":"bank_passwords"}</vault-query>', "Sorry, I can't do that."];
    const res = await app.inject({ method: "POST", url: "/api/v1/ai/chat", headers: auth, payload: { message: "x" } });
    expect(res.statusCode).toBe(200);
    expect(calls[1]!.at(-1)!.content).toContain("Couldn't read this look-up");
  });

  it("refuses to recategorize when nothing matches", async () => {
    replies = ['<vault-action>{"type":"recategorize","merchant":"nothing like this","category":"Dining Out"}</vault-action>'];
    const out = lines(
      (await app.inject({ method: "POST", url: "/api/v1/ai/chat", headers: auth, payload: { message: "y", autoApply: true } })).payload,
    );
    const [action] = out.find((l) => "actions" in l)!["actions"] as Array<{ status: string; error: string }>;
    expect(action!.status).toBe("failed");
    expect(action!.error).toMatch(/No transactions matched/);
  });
});

describe("rule check", () => {
  it("orders a mixed income + expense list by splitting it, instead of failing", async () => {
    replies = [
      '<vault-action>{"type":"reorder_categories","parent":null,"order":["Salary","Groceries","Dining Out","Gifts","Interest","Transport"]}</vault-action>',
    ];
    const out = lines(
      (await app.inject({ method: "POST", url: "/api/v1/ai/chat", headers: auth, payload: { message: "order", autoApply: true } })).payload,
    );
    const [action] = out.find((l) => "actions" in l)!["actions"] as Array<{ status: string; error: string | null }>;
    expect(action).toMatchObject({ status: "applied", error: null });
    const cats = (await api("GET", "/categories")).categories as Array<{ name: string; kind: string; parentCategoryId: string | null }>;
    const top = (kind: string) => cats.filter((c) => c.kind === kind && c.parentCategoryId === null).map((c) => c.name);
    expect(top("income").slice(0, 3)).toEqual(["Salary", "Gifts", "Interest"]);
    expect(top("expense").slice(0, 3)).toEqual(["Groceries", "Dining Out", "Transport"]);
  });

  it("sends broken changes back to the model, keeps its fixes and drops what's still wrong", async () => {
    calls.length = 0;
    replies = [
      "Here's the plan.\n" +
        '<vault-action>{"type":"set_budget","category":"Groceries","amount":600}</vault-action>\n' +
        '<vault-action>{"type":"set_budget","category":"Salary","amount":100}</vault-action>\n' +
        '<vault-action>{"type":"create_rule","keyword":"kettle","category":"Coffee Shops"}</vault-action>\n' +
        '<vault-action>{"type":"move_category","category":"Gifts","newParent":"Shopping"}</vault-action>',
      "Fixed the rule; Salary can't have a budget.\n" +
        '<vault-action>{"type":"create_rule","keyword":"kettle","category":"Dining Out"}</vault-action>\n' +
        '<vault-action>{"type":"move_category","category":"Gifts","newParent":"Shopping"}</vault-action>',
    ];
    const out = lines((await app.inject({ method: "POST", url: "/api/v1/ai/chat", headers: auth, payload: { message: "plan" } })).payload);

    expect(calls).toHaveLength(2);
    const report = calls[1]!.at(-1)!.content;
    expect(report).toContain("RULE CHECK");
    expect(report).toContain("budgets are for spending categories");
    expect(report).toContain('no category called "Coffee Shops"');
    expect(report).toMatch(/income category and "Shopping" is expense/);
    expect(report).not.toContain('"Groceries"');
    expect(out.some((l) => l["status"] === "Double-checking the changes…")).toBe(true);

    const actions = out.find((l) => "actions" in l)!["actions"] as Array<{ action: Record<string, unknown>; status: string }>;
    expect(actions.map((a) => a.action)).toEqual([
      { type: "set_budget", category: "Groceries", amount: 600 },
      { type: "create_rule", keyword: "kettle", category: "Dining Out" },
    ]);
    expect(actions.every((a) => a.status === "pending")).toBe(true);
  });
});
