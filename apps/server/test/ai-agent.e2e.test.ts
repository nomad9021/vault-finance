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

type ActionRow = { id: string; action: { type: string }; status: string; error: string | null; client?: boolean };

/**
 * The changes from one auto-mode reply, after the user clicks every one auto
 * mode held back (it only applies new or cosmetic things on its own). Returns
 * them in order, with what auto mode did first in `held`.
 */
const clickThrough = async (out: Array<Record<string, unknown>>) => {
  const actions = out.find((l) => "actions" in l)!["actions"] as ActionRow[];
  const held = actions.map((a) => a.status === "pending" && !a.client);
  const done: ActionRow[] = [];
  for (const a of actions) {
    if (a.status !== "pending" || a.client) {
      done.push(a);
      continue;
    }
    const res = await app.inject({ method: "POST", url: `/api/v1/ai/actions/${a.id}/approve`, headers: auth, payload: {} });
    done.push(res.json() as ActionRow);
  }
  return { actions: done, held };
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
    expect(out[1]?.["status"]).toMatch(/agents are on it/);
    expect(out.filter((l) => "status" in l).map((l) => l["status"])).toContain("Checking your merchants…");

    // The guide teaches the look-ups and the new changes.
    expect(calls[0]![0]!.content).toContain("<vault-query>");
    expect(calls[0]![0]!.content).toContain("reorder_categories");
    expect(calls[0]![0]!.content).toContain("Uncategorized transactions (all time): 3.");

    // Auto mode reordered on its own; recategorizing waited for a click.
    const { actions, held } = await clickThrough(out);
    expect(held).toEqual([true, false]);
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
    const [action] = (await clickThrough(out)).actions;
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

describe("specialist agents", () => {
  const chat = async (message: string, extra: Record<string, unknown> = {}) =>
    lines((await app.inject({ method: "POST", url: "/api/v1/ai/chat", headers: auth, payload: { message, ...extra } })).payload);

  it("routes a salary question to the tax agent and teaches only what it needs", async () => {
    calls.length = 0;
    replies = ["Sure."];
    const out = await chat("What would my take-home be on a $95k salary?");
    expect(out[1]).toEqual({ status: "Tax & salary agent is on it…" });
    const system = calls[0]![0]!.content;
    expect(system).toContain("--- Tax & salary agent ---");
    expect(system).toContain("TAX PROFILE:");
    expect(system).not.toContain("--- Giving agent ---");
    expect(system).toContain("Also available if the user asks");
  });

  it("sets up salary and taxes, then answers what-ifs from the engine", async () => {
    calls.length = 0;
    replies = [
      'Setting that up.\n<vault-action>{"type":"set_tax_profile","state":"CO","filingStatus":"single"}</vault-action>\n' +
        '<vault-action>{"type":"set_salary","earner":"Alex","grossAnnual":100000}</vault-action>\n' +
        '<vault-action>{"type":"set_pretax","earner":"Alex","retirementPct":0}</vault-action>',
    ];
    const out = await chat("My salary is $100k and I live in Colorado", { autoApply: true });
    const { actions, held } = await clickThrough(out);
    expect(held).toEqual([true, true, true]); // salary and taxes always wait for a click
    expect(actions.map((a) => a.status)).toEqual(["applied", "applied", "applied"]);
    const { estimate } = await api("GET", "/tax-profile");
    expect(estimate.takeHomeCents).toBe(7_548_840);
    expect((await api("GET", "/budget-plan")).plannedIncomeCents).toBe(Math.round(7_548_840 / 12));

    calls.length = 0;
    replies = [
      '<vault-query>{"type":"tax_compare","states":["TX","CA"]}</vault-query>\n<vault-query>{"type":"tax_whatif","grossAnnual":110000}</vault-query>',
      "Texas would leave you more.",
    ];
    await chat("How much more would I take home if I moved to Texas, or got a raise to 110k?");
    const results = calls[1]!.at(-1)!.content;
    expect(results).toContain("Texas: take-home $79180.00/yr"); // CO take-home + the $3,691.60 CO tax
    expect(results).toContain("TAX WHAT-IF (not saved)");
    expect(results).toMatch(/compared with now: take-home \+\$/);
  });

  it("bills, goals and the debt plan go through the same checks and cards", async () => {
    replies = [
      '<vault-action>{"type":"create_bill","name":"Rent","amount":1500,"dueDay":1,"category":"Mortgage & Rent"}</vault-action>\n' +
        '<vault-action>{"type":"create_goal","name":"Emergency fund","target":10000,"monthly":400}</vault-action>\n' +
        '<vault-action>{"type":"set_debt_plan","strategy":"snowball","extraMonthly":150}</vault-action>\n' +
        '<vault-action>{"type":"update_bill","bill":"Netflix","amount":20}</vault-action>',
      "Netflix isn't a bill yet, so I left it.",
    ];
    const out = await chat("Set up my bills, an emergency fund goal, and a snowball debt plan", { autoApply: true });
    const { actions, held } = await clickThrough(out);
    expect(held).toEqual([false, false, true]); // new bill + goal applied; the debt plan waited
    expect(actions.map((a) => [a.action.type, a.status])).toEqual([
      ["create_bill", "applied"],
      ["create_goal", "applied"],
      ["set_debt_plan", "applied"],
    ]);
    expect((await api("GET", "/bills")).bills.map((b: { name: string }) => b.name)).toContain("Rent");
    expect((await api("GET", "/goals")).goals[0]).toMatchObject({ name: "Emergency fund", targetCents: 1_000_000, monthlyCents: 40_000 });
    expect(await api("GET", "/debt-plan")).toMatchObject({ strategy: "snowball", extraCents: 15_000 });
  });

  it("refuses a salary before there's a state, and asks the model to fix it", async () => {
    // A fresh profile would need a state; here the saved one already has CO, so
    // test the rule directly through a bad locality instead.
    calls.length = 0;
    replies = [
      '<vault-action>{"type":"set_tax_profile","locality":"nyc"}</vault-action>',
      "Right, NYC isn't in Colorado — no change.",
    ];
    const out = await chat("Add New York City tax to my taxes");
    expect(calls[1]!.at(-1)!.content).toContain("New York City is in NY, not CO");
    expect(out.find((l) => "actions" in l)).toBeUndefined();
  });
});

describe("never an empty reply", () => {
  it("explains when every proposed change is dropped", async () => {
    replies = [
      '<vault-action>{"type":"create_category","name":"Taxes","parent":"Income"}</vault-action>',
      '<vault-action>{"type":"create_category","name":"Taxes","parent":"Nowhere"}</vault-action>',
    ];
    const out = lines((await app.inject({ method: "POST", url: "/api/v1/ai/chat", headers: auth, payload: { message: "add taxes" } })).payload);
    const text = out.filter((l) => "token" in l).map((l) => l["token"]).join("");
    expect(text).toContain("I couldn't make those changes:");
    expect(text).toContain('no category called "Income"');
    expect(out.find((l) => "actions" in l)).toBeUndefined();
  });

  it("introduces the cards when the model wrote only change blocks", async () => {
    replies = ['<vault-action>{"type":"set_budget","category":"Groceries","amount":500}</vault-action>'];
    const out = lines((await app.inject({ method: "POST", url: "/api/v1/ai/chat", headers: auth, payload: { message: "budget groceries" } })).payload);
    const text = out.filter((l) => "token" in l).map((l) => l["token"]).join("");
    expect(text).toContain("Here's what I'd change (1 change):");
    const convo = out.find((l) => "done" in l)!["conversationId"] as string;
    expect((await api("GET", `/ai/conversations/${convo}`)).messages.at(-1).content).toBe("Here's what I'd change (1 change):");
  });
});

describe("completion check", () => {
  it("asks for the change when the model only claims it", async () => {
    calls.length = 0;
    replies = [
      "Done — Shell charges are now in Transport.",
      '<vault-action>{"type":"create_rule","keyword":"shell","category":"Transport"}</vault-action>',
    ];
    const out = lines((await app.inject({ method: "POST", url: "/api/v1/ai/chat", headers: auth, payload: { message: "Always put Shell in Transport" } })).payload);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.at(-1)!.content).toContain("wrote no <vault-action> block");
    const actions = out.find((l) => "actions" in l)!["actions"] as Array<{ action: { type: string } }>;
    expect(actions.map((a) => a.action.type)).toEqual(["create_rule"]);
  });

  it("leaves plain answers alone", async () => {
    calls.length = 0;
    replies = ["You spent $565 at Kroger."];
    await app.inject({ method: "POST", url: "/api/v1/ai/chat", headers: auth, payload: { message: "How much did I spend at Kroger?" } });
    expect(calls).toHaveLength(1);
  });
});

describe("stop", () => {
  it("sends the conversation id first, so a stopped reply stays in its chat", async () => {
    replies = ["Hello."];
    const out = lines((await app.inject({ method: "POST", url: "/api/v1/ai/chat", headers: auth, payload: { message: "hi" } })).payload);
    expect(out[0]).toMatchObject({ started: true });
    expect(out[0]!["conversationId"]).toBe(out.find((l) => "done" in l)!["conversationId"]);
  });
});

describe("savings buckets through the assistant", () => {
  it("creates buckets, moves money and refuses unknown accounts", async () => {
    await api("POST", "/accounts", { name: "Ally Savings", type: "savings", balanceCents: 500_000 });
    replies = [
      '<vault-action>{"type":"create_bucket","account":"Ally Savings","name":"Vacation","amount":2000,"target":3000}</vault-action>\n' +
        '<vault-action>{"type":"create_bucket","account":"Ally Savings","name":"Emergency"}</vault-action>\n' +
        '<vault-action>{"type":"move_bucket_money","from":"Unassigned","to":"Emergency","amount":1500}</vault-action>\n' +
        '<vault-action>{"type":"create_bucket","account":"Mattress","name":"Nope"}</vault-action>',
      "That account doesn't exist, so I skipped it.",
    ];
    const out = lines((await app.inject({ method: "POST", url: "/api/v1/ai/chat", headers: auth, payload: { message: "Split my savings into vacation and emergency buckets", autoApply: true } })).payload);
    const { actions, held } = await clickThrough(out);
    // Moving money always waits for a click, even in auto mode.
    expect(held).toEqual([false, false, true]);
    expect(actions.map((a) => a.status)).toEqual(["applied", "applied", "applied"]);
    const acct = (await api("GET", "/buckets")).accounts.find((a: { accountName: string }) => a.accountName === "Ally Savings");
    expect(acct.buckets.map((b: { name: string; allocatedCents: number }) => [b.name, b.allocatedCents])).toEqual([["Vacation", 200_000], ["Emergency", 150_000]]);
    expect(acct.unassignedCents).toBe(150_000);
  });
});

describe("before income through the assistant", () => {
  it("adds and updates pay-stub items, turns the estimate off and refuses unknown items", async () => {
    calls.length = 0;
    replies = [
      '<vault-action>{"type":"set_pre_income_item","name":"Federal tax","amount":480,"kind":"tax"}</vault-action>\n' +
        '<vault-action>{"type":"set_pre_income_item","name":"Health insurance","amount":150,"kind":"deduction"}</vault-action>\n' +
        '<vault-action>{"type":"set_pre_income_item","name":"Federal tax","amount":495}</vault-action>\n' +
        '<vault-action>{"type":"set_pre_income_estimate","use":false}</vault-action>\n' +
        '<vault-action>{"type":"remove_pre_income_item","name":"Union dues"}</vault-action>',
      "Union dues isn't an item, so it was left out.",
    ];
    const out = lines((await app.inject({ method: "POST", url: "/api/v1/ai/chat", headers: auth, payload: { message: "Take my pay stub taxes out before income on the Sankey", autoApply: true } })).payload);
    const system = calls[0]![0]!.content;
    expect(system).toContain("BEFORE-INCOME ITEMS");
    expect(system).toContain("=== WHAT YOU CAN AND CAN'T DO ===");
    const { actions } = await clickThrough(out);
    expect(actions.map((a) => [a.action.type, a.status])).toEqual([
      ["set_pre_income_item", "applied"],
      ["set_pre_income_item", "applied"],
      ["set_pre_income_item", "applied"],
      ["set_pre_income_estimate", "applied"],
    ]);
    const pre = await api("GET", "/pre-income");
    expect(pre.useEstimate).toBe(false);
    expect(pre.items.map((i: { name: string; kind: string; monthlyCents: number }) => [i.name, i.kind, i.monthlyCents])).toEqual([
      ["Federal tax", "tax", 49_500],
      ["Health insurance", "deduction", 15_000],
    ]);
  });

  it("rejects two items with the same id", async () => {
    const item = { id: "x", name: "A", kind: "tax", monthlyCents: 100 };
    const res = await app.inject({ method: "PUT", url: "/api/v1/pre-income", headers: auth, payload: { items: [item, { ...item, name: "B" }], useEstimate: true } });
    expect(res.statusCode).toBe(400);
  });
});

describe("style and limits", () => {
  it("tells every agent how to answer and what it can't do", async () => {
    calls.length = 0;
    replies = ["I can't do that."];
    await app.inject({ method: "POST", url: "/api/v1/ai/chat", headers: auth, payload: { message: "Pay my rent from checking" } });
    const system = calls[0]![0]!.content;
    expect(system).toContain("=== HOW TO ANSWER ===");
    expect(system).toMatch(/Move, send, transfer or pay real money/);
  });
});
