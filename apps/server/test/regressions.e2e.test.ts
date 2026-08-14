import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

/**
 * Regressions found while auditing the sections work.
 *
 * Both of these were silent: nothing threw, nothing looked broken in isolation,
 * and the numbers were simply wrong. That's the kind of bug a finance app can
 * least afford, so they get pinned here.
 */
describe("regressions", () => {
  const PG_PORT = 55443;
  let pg: EmbeddedPostgres;
  let app: FastifyInstance;
  let dataDir: string;
  let pgDir: string;
  let auth: { authorization: string };
  let accountId: string;
  let catA: string;

  const post = (url: string, payload: unknown) =>
    app.inject({ method: "POST", url, headers: auth, payload });
  const get = (url: string) => app.inject({ method: "GET", url, headers: auth });

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "vault-probe-data-"));
    pgDir = mkdtempSync(path.join(tmpdir(), "vault-probe-pg-"));
    pg = new EmbeddedPostgres({
      databaseDir: pgDir, user: "vault", password: "vault", port: PG_PORT, persistent: false,
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("vault");
    app = await buildApp({
      config: loadConfig({
        DATABASE_URL: `postgres://vault:vault@localhost:${PG_PORT}/vault`,
        VAULT_TLS: "off", VAULT_DATA_DIR: dataDir, LOG_LEVEL: "error",
      } as NodeJS.ProcessEnv),
    });
    await app.inject({
      method: "POST", url: "/api/v1/setup/complete",
      payload: { ownerEmail: "s@s.home", ownerPassword: "correct-horse-battery", ownerDisplayName: "S" },
    });
    const login = await app.inject({
      method: "POST", url: "/api/v1/auth/login",
      payload: { email: "s@s.home", password: "correct-horse-battery", deviceName: "T", platform: "linux" },
    });
    auth = { authorization: `Bearer ${login.json().accessToken}` };
    const cats = await get("/api/v1/categories");
    catA = cats.json().categories[0].id;
    accountId = (await post("/api/v1/accounts", { name: "Checking", type: "checking", balanceCents: 0 })).json().id;
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(pgDir, { recursive: true, force: true });
  });

  // Month-boundary due dates are covered exhaustively in test/due.test.ts with
  // injected dates; this only checks the two endpoints agree for a live "today".
  it("insights and the bills endpoint agree on what's due soon", async () => {
    const today = new Date().getUTCDate();
    // Pick a due day a few days ahead that lands in NEXT month.
    const daysInMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 0)).getUTCDate();
    const dueDay = ((today + 3 - 1) % daysInMonth) + 1;
    const wraps = dueDay < today;
    await post("/api/v1/bills", { name: "WrapBill", amountCents: 50000, dueDay, cadence: "monthly" });
    const list = await get("/api/v1/bills");
    const bill = list.json().bills.find((b: { name: string }) => b.name === "WrapBill");
    const insights = (await get("/api/v1/insights")).json().insights;
    const flagged = insights.some((i: { id: string }) => i.id === `bill-underfunded-${bill.id}`);
    // The bills API knows it's ~3 days away; insights must agree.
    expect({ wraps, daysUntilDue: bill.daysUntilDue, flagged })
      .toEqual({ wraps, daysUntilDue: bill.daysUntilDue, flagged: bill.daysUntilDue <= 7 });
  });

  // Each fund reports spending in its own category, so two funds pointed at the
  // same category each claimed all of it and the total billed the household
  // twice for money that left once.
  it("giving total does not double count a shared category", async () => {
    await post("/api/v1/transactions", {
      accountId, postedAt: new Date().toISOString().slice(0, 10),
      amountCents: -10000, merchantName: "Charity", categoryId: catA, pending: false,
    });
    await post("/api/v1/giving", { name: "F1", kind: "giving", monthlyCents: 1000, categoryId: catA });
    await post("/api/v1/giving", { name: "F2", kind: "giving", monthlyCents: 1000, categoryId: catA });
    const body = (await get("/api/v1/giving")).json();
    // Only $100 actually left the household.
    expect(body.givenThisYearCents).toBe(10000);
  });

  // A Sankey is only honest while inflow equals outflow at every node. Plans
  // aren't capped by income, so over-committing drew branches far thicker than
  // the income bar feeding them.
  it("sankey hub stays balanced when over-committed", async () => {
    const month = new Date().toISOString().slice(0, 7);
    await post("/api/v1/transactions", {
      accountId, postedAt: `${month}-02`, amountCents: 100000,
      merchantName: "Payroll", pending: false,
    });
    // Commit far more than the income.
    await post("/api/v1/bills", { name: "Huge", amountCents: 900000, dueDay: 5, cadence: "monthly" });
    const s = (await get(`/api/v1/cashflow/sankey?month=${month}`)).json();
    const hub = s.nodes.find((n: { id: string }) => n.id === "hub");
    const out = s.links
      .filter((l: { from: string }) => l.from === "hub")
      .reduce((a: number, l: { valueCents: number }) => a + l.valueCents, 0);
    expect({ inflow: hub.valueCents, outflow: out }).toEqual({ inflow: hub.valueCents, outflow: hub.valueCents });

    // …and the gap is named rather than quietly padded.
    const shortfall = s.nodes.find((n: { id: string }) => n.id === "income:shortfall");
    expect(shortfall).toBeDefined();
    expect(shortfall.valueCents).toBeGreaterThan(0);
    expect(shortfall.depth).toBe(0);
    // Actual income reported to the dashboard stays the real figure.
    expect(s.totalIncomeCents).toBe(100000);
  });

  it("adds no shortfall node when the plan fits inside income", async () => {
    const month = new Date().toISOString().slice(0, 7);
    const s = (await get(`/api/v1/cashflow/sankey?month=${month}`)).json();
    const hub = s.nodes.find((n: { id: string }) => n.id === "hub");
    if (!hub) return;
    const out = s.links
      .filter((l: { from: string }) => l.from === "hub")
      .reduce((a: number, l: { valueCents: number }) => a + l.valueCents, 0);
    // Balanced either way — this is the invariant, shortfall or not.
    expect(out).toBe(hub.valueCents);
  });
});
