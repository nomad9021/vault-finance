/**
 * AI quality evaluation — OFF by default. Sends everyday requests to real
 * models through the real chat endpoint (agents, look-ups, rule check, auto
 * mode) against a realistic household, then checks what actually changed.
 *
 *   VAULT_AI_EVAL=1 VAULT_AI_URL=http://<ai-server>:8080/v1 VAULT_AI_KEY_FILE=<file> \
 *   VAULT_AI_MODELS=general,smart,fast npx vitest run test/ai-eval.test.ts
 *
 * Prints a scorecard (and writes it to VAULT_AI_EVAL_OUT if set). The key is
 * read from a file so it never lands in shell history or the output.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { FastifyInstance } from "fastify";
import { describe, it } from "vitest";
import { buildTestApp as buildApp } from "./helpers/test-app.js";
import { loadConfig } from "../src/config.js";

const ON = process.env.VAULT_AI_EVAL === "1";
const PG_PORT = 55590;

type Api = (method: string, url: string, payload?: unknown) => Promise<any>;
interface Scenario {
  name: string;
  message: string;
  check: (api: Api, reply: string) => Promise<string | null>; // null = pass, else why it failed
}

const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
const cat = async (api: Api, name: string) =>
  (await api("GET", "/categories")).categories.find((c: { name: string }) => c.name.toLowerCase() === name.toLowerCase());

const SCENARIOS: Scenario[] = [
  {
    name: "rename",
    message: "Rename Dining Out to Restaurants",
    check: async (api) => ((await cat(api, "Restaurants")) && !(await cat(api, "Dining Out")) ? null : "Dining Out not renamed"),
  },
  {
    name: "move",
    message: "Put Coffee Shops under Dining Out",
    check: async (api) => {
      const [c, d] = [await cat(api, "Coffee Shops"), await cat(api, "Dining Out")];
      return c && d && c.parentCategoryId === d.id ? null : "Coffee Shops not under Dining Out";
    },
  },
  {
    name: "nest-new",
    message: "Create a Pets category with Vet and Pet Food under it",
    check: async (api) => {
      const [p, v, f] = [await cat(api, "Pets"), await cat(api, "Vet"), await cat(api, "Pet Food")];
      return p && v && f && v.parentCategoryId === p.id && f.parentCategoryId === p.id ? null : "Pets tree not created";
    },
  },
  {
    name: "color",
    message: "Make Groceries green",
    check: async (api) => {
      const g = await cat(api, "Groceries");
      const [r, gg, b] = [1, 3, 5].map((i) => parseInt(g.color.slice(i, i + 2), 16));
      return gg > r && gg > b ? null : `Groceries color is ${g.color}`;
    },
  },
  {
    name: "budget-one",
    message: "Set my grocery budget to $500 a month",
    check: async (api) => {
      const g = await cat(api, "Groceries");
      const b = (await api("GET", "/budgets")).budgets.find((x: { categoryId: string }) => x.categoryId === g.id);
      return b?.amountCents === 50_000 ? null : `grocery budget ${b?.amountCents ?? "missing"}`;
    },
  },
  {
    name: "budget-history",
    message: "Set up budgets based on what I usually spend",
    check: async (api) => {
      const n = (await api("GET", "/budgets")).budgets.length;
      return n >= 3 ? null : `only ${n} budgets`;
    },
  },
  {
    name: "recategorize",
    message: "Move all my Amazon purchases to Shopping",
    check: async (api) => {
      const s = await cat(api, "Shopping");
      const t = (await api("GET", "/transactions?search=amazon&limit=100")).transactions;
      const wrong = t.filter((x: { categoryId: string | null }) => x.categoryId !== s.id).length;
      return wrong === 0 ? null : `${wrong} of ${t.length} Amazon charges not in Shopping`;
    },
  },
  {
    name: "rule",
    message: "From now on always put Shell gas station charges in Transport",
    check: async (api) => {
      const t = await cat(api, "Transport");
      const rules = (await api("GET", "/categorization-rules")).rules;
      return rules.some((r: { keyword: string; categoryId: string }) => /shell/i.test(r.keyword) && r.categoryId === t.id) ? null : "no Shell → Transport rule";
    },
  },
  {
    name: "bill",
    message: "Add my rent as a bill: $1,450 due on the 1st",
    check: async (api) => {
      const b = (await api("GET", "/bills")).bills.find((x: { name: string }) => /rent/i.test(x.name));
      return b && b.amountCents === 145_000 && b.dueDay === 1 ? null : `rent bill ${b ? `${b.amountCents} day ${b.dueDay}` : "missing"}`;
    },
  },
  {
    name: "goal",
    message: "I want to save $6,000 for a vacation by next June",
    check: async (api) => {
      const g = (await api("GET", "/goals")).goals.find((x: { name: string }) => /vacation|trip|travel/i.test(x.name));
      return g?.targetCents === 600_000 ? null : `vacation goal ${g?.targetCents ?? "missing"}`;
    },
  },
  {
    name: "tax",
    message: "I make $60k a year and live in Grand Rapids, Michigan. Set up my taxes.",
    check: async (api) => {
      const { profile } = await api("GET", "/tax-profile");
      if (!profile) return "no tax profile";
      if (profile.state !== "MI") return `state ${profile.state}`;
      if (profile.locality !== "grand_rapids") return `locality ${profile.locality}`;
      return profile.earners[0]?.grossAnnualCents === 6_000_000 ? null : `salary ${profile.earners[0]?.grossAnnualCents}`;
    },
  },
  {
    name: "question",
    message: "How much did I spend at Kroger in the last 30 days?",
    check: async (api, reply) => {
      const t = (await api("GET", `/transactions?search=kroger&from=${day(30)}&limit=100`)).transactions;
      const total = -t.reduce((s: number, x: { amountCents: number }) => s + x.amountCents, 0) / 100;
      const nums = [...reply.replace(/,/g, "").matchAll(/\$?(\d+(?:\.\d{1,2})?)/g)].map((m) => Number(m[1]));
      return nums.some((n) => Math.abs(n - total) < 1) ? null : `expected ~$${total.toFixed(2)}, reply: ${reply.slice(0, 120)}`;
    },
  },
];

async function seed(api: Api) {
  const checking = await api("POST", "/accounts", { name: "Checking", type: "checking", balanceCents: 420_000 });
  await api("POST", "/accounts", { name: "Savings", type: "savings", balanceCents: 1_250_000 });
  await api("POST", "/categories", { name: "Coffee Shops", color: "#a0522d", parentCategoryId: null, kind: "expense" });
  const ids = Object.fromEntries((await api("GET", "/categories")).categories.map((c: { name: string; id: string }) => [c.name, c.id]));
  const tx = (d: number, merchant: string, dollars: number, category: string | null) =>
    api("POST", "/transactions", {
      accountId: checking.id,
      postedAt: day(d),
      amountCents: Math.round(dollars * 100),
      merchantName: merchant,
      categoryId: category ? ids[category] : null,
    });
  for (let d = 2; d < 90; d += 7) await tx(d, "KROGER #882", -(95 + (d % 5) * 9), "Groceries");
  for (let d = 4; d < 90; d += 14) await tx(d, "ACME CORP PAYROLL", 2_150, "Salary");
  for (let d = 1; d < 90; d += 30) await tx(d, "LAKESIDE APARTMENTS", -1_450, "Mortgage & Rent");
  for (let d = 6; d < 90; d += 30) await tx(d, "NETFLIX.COM", -15.49, "Subscriptions");
  for (let d = 3; d < 90; d += 9) await tx(d, "SHELL OIL 5523", -(42 + (d % 3) * 6), null);
  for (let d = 5; d < 90; d += 11) await tx(d, "AMAZON MKTPL", -(27 + (d % 7) * 8), d % 2 ? "Everything Else" : null);
  for (let d = 2; d < 90; d += 6) await tx(d, "STARBUCKS #1182", -6.85, null);
  for (let d = 8; d < 90; d += 10) await tx(d, "CHIPOTLE 1123", -(14 + (d % 4)), "Dining Out");
}

describe.skipIf(!ON)("AI quality evaluation", () => {
  it("scores each model on everyday requests", async () => {
    const key = readFileSync(process.env.VAULT_AI_KEY_FILE!, "utf8").trim();
    const models = (process.env.VAULT_AI_MODELS ?? "general").split(",");
    const only = process.env.VAULT_AI_SCENARIOS?.split(",");
    const pgDir = mkdtempSync(path.join(tmpdir(), "vault-eval-pg-"));
    const pg = new EmbeddedPostgres({ databaseDir: pgDir, user: "vault", password: "vault", port: PG_PORT, persistent: false });
    await pg.initialise();
    await pg.start();
    const lines: string[] = [];
    let n = 0;
    try {
      for (const model of models) {
        let pass = 0;
        let ran = 0;
        for (const s of SCENARIOS.filter((x) => !only || only.includes(x.name))) {
          const db = `eval_${++n}`;
          await pg.createDatabase(db);
          const dataDir = mkdtempSync(path.join(tmpdir(), "vault-eval-data-"));
          const app: FastifyInstance = await buildApp({
            config: loadConfig({ DATABASE_URL: `postgres://vault:vault@localhost:${PG_PORT}/${db}`, VAULT_TLS: "off", VAULT_DATA_DIR: dataDir, LOG_LEVEL: "error" } as NodeJS.ProcessEnv),
          });
          try {
            await app.inject({ method: "POST", url: "/api/v1/setup/complete", payload: { ownerEmail: "e@e.home", ownerPassword: "correct-horse-battery", ownerDisplayName: "Eval" } });
            const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "e@e.home", password: "correct-horse-battery", deviceName: "E", platform: "linux" } });
            const auth = { authorization: `Bearer ${login.json().accessToken}` };
            const api: Api = async (method, url, payload) =>
              (await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: auth, ...(payload ? { payload: payload as object } : {}) })).json();
            await api("POST", "/ai/settings", {
              enabled: true,
              provider: "local_openai",
              model,
              baseUrl: process.env.VAULT_AI_URL,
              apiKey: key,
              qualityModels: { low: model, normal: model, high: model },
            });
            await seed(api);
            const started = Date.now();
            const res = await app.inject({ method: "POST", url: "/api/v1/ai/chat", headers: auth, payload: { message: s.message, autoApply: true } });
            const out = res.payload.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
            const reply = out.filter((l) => "token" in l).map((l) => l["token"]).join("").replace(/<vault-[a-z]+>[\s\S]*?<\/vault-[a-z]+>/g, "").trim();
            const proposed = (out.find((l) => "actions" in l)?.["actions"] ?? []) as Array<{ id: string; summary: string; status: string; error: string | null; client?: boolean }>;
            // Auto mode holds back changes to existing data; click them through
            // so the scorecard measures the model, not that safeguard.
            const actions = [];
            for (const a of proposed) {
              if (a.status !== "pending" || a.client) { actions.push(a); continue; }
              const done = await app.inject({ method: "POST", url: `/api/v1/ai/actions/${a.id}/approve`, headers: auth, payload: {} });
              actions.push(done.json() as typeof a);
            }
            const why = await s.check(api, reply).catch((e) => `check crashed: ${e}`);
            const steps = out.filter((l) => "status" in l).map((l) => l["status"]).slice(1).join(" / ");
            const raw = out.filter((l) => "token" in l).map((l) => l["token"]).join("");
            const asked = [...raw.matchAll(/vault-query>?([\s\S]*?)<\/vault-query>/g)].map((m) => m[1]!.trim()).join(" ");
            ran++;
            if (!why) pass++;
            lines.push(
              `${model.padEnd(10)} ${s.name.padEnd(15)} ${why ? "FAIL" : "pass"} ${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s` +
                (why ? `  ${why} | cards: ${actions.map((a) => `${a.summary} [${a.status}${a.error ? `: ${a.error}` : ""}]`).join("; ") || "none"} | steps: ${steps || "none"} ${asked} | said: ${reply.slice(0, 160).replace(/\s+/g, " ")}` : ""),
            );
            console.log(lines.at(-1));
          } finally {
            await app.close();
            rmSync(dataDir, { recursive: true, force: true });
          }
        }
        lines.push(`${model}: ${pass}/${ran} passed`, "");
        console.log(lines.at(-2));
      }
    } finally {
      await pg.stop();
      rmSync(pgDir, { recursive: true, force: true });
      if (process.env.VAULT_AI_EVAL_OUT) writeFileSync(process.env.VAULT_AI_EVAL_OUT, lines.join("\n"));
    }
  }, 3_600_000);
});
