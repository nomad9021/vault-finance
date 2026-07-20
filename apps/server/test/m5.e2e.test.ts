import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

/** M5: cashflow summary + sankey, investments, goals, reports, CSV export. */

const PG_PORT = 55439;
let pg: EmbeddedPostgres;
let app: FastifyInstance;
let dataDir: string;
let pgDir: string;
let auth: { authorization: string };

let checkingId: string;
let brokerageId: string;
let incomeCatId: string;
let groceriesId: string;

const THIS_MONTH = new Date().toISOString().slice(0, 7);
const LAST_MONTH = new Date(
  Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1),
)
  .toISOString()
  .slice(0, 7);

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "vault-m5-data-"));
  pgDir = mkdtempSync(path.join(tmpdir(), "vault-m5-pg-"));

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
      aiConfig: { ollamaHost: "127.0.0.1", ollamaPort: 1, modelName: "x", enabled: false },
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

  const cats = await app.inject({ method: "GET", url: "/api/v1/categories", headers: auth });
  const byName = new Map(
    cats.json().categories.map((c: { name: string; id: string }) => [c.name, c.id]),
  );
  incomeCatId = byName.get("Income") as string;
  groceriesId = byName.get("Groceries") as string;

  const checking = await app.inject({
    method: "POST",
    url: "/api/v1/accounts",
    headers: auth,
    payload: { name: "Checking", type: "checking", balanceCents: 0 },
  });
  checkingId = checking.json().id;
  const brokerage = await app.inject({
    method: "POST",
    url: "/api/v1/accounts",
    headers: auth,
    payload: { name: "Brokerage", type: "investment", balanceCents: 0 },
  });
  brokerageId = brokerage.json().id;

  // Two months of flows: income 4000/mo, groceries 500 (last) / 300 (this).
  const txns = [
    { postedAt: `${LAST_MONTH}-05`, amountCents: 400_000, categoryId: incomeCatId, merchantName: "Payroll" },
    { postedAt: `${LAST_MONTH}-10`, amountCents: -50_000, categoryId: groceriesId, merchantName: "Grocer" },
    { postedAt: `${THIS_MONTH}-05`, amountCents: 400_000, categoryId: incomeCatId, merchantName: "Payroll" },
    { postedAt: `${THIS_MONTH}-08`, amountCents: -30_000, categoryId: groceriesId, merchantName: "Grocer" },
  ];
  for (const t of txns) {
    await app.inject({
      method: "POST",
      url: "/api/v1/transactions",
      headers: auth,
      payload: { accountId: checkingId, pending: false, ...t },
    });
  }
});

afterAll(async () => {
  await app?.close();
  await pg?.stop();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(pgDir, { recursive: true, force: true });
});

describe("cashflow", () => {
  it("summarizes income/spending/savings-rate per month", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/cashflow/summary?months=2",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const months = res.json().months;
    expect(months).toHaveLength(2);
    expect(months[0]).toMatchObject({
      month: LAST_MONTH,
      incomeCents: 400_000,
      spendingCents: 50_000,
      netCents: 350_000,
      savingsRate: 0.875,
    });
    expect(months[1]).toMatchObject({ month: THIS_MONTH, spendingCents: 30_000 });
  });

  it("builds balanced multi-level sankey data with a Saved leaf", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/cashflow/sankey?month=${THIS_MONTH}`,
      headers: auth,
    });
    const body = res.json();
    expect(body.totalIncomeCents).toBe(400_000);
    expect(body.totalSpendingCents).toBe(30_000);

    const income = body.nodes.find((n: { kind: string }) => n.kind === "income");
    expect(income).toMatchObject({ label: "Income", valueCents: 400_000, depth: 0 });
    const hub = body.nodes.find((n: { kind: string }) => n.kind === "hub");
    expect(hub).toMatchObject({ valueCents: 400_000, depth: 1 });

    const saved = body.nodes.find((n: { id: string }) => n.id === "saved");
    expect(saved).toMatchObject({ valueCents: 370_000, depth: 2 }); // diagram balances
    const groceries = body.nodes.find((n: { id: string }) => n.id === `cat:${groceriesId}`);
    expect(groceries).toMatchObject({ valueCents: 30_000, categoryId: groceriesId, depth: 2 });

    expect(body.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: income.id, to: "hub", valueCents: 400_000 }),
        expect.objectContaining({ from: "hub", to: `cat:${groceriesId}`, valueCents: 30_000 }),
        expect.objectContaining({ from: "hub", to: "saved", valueCents: 370_000 }),
      ]),
    );
  });

  it("branches spending into subcategories via parentCategoryId", async () => {
    const parent = await app.inject({
      method: "POST",
      url: "/api/v1/categories",
      headers: auth,
      payload: { name: "Investments", color: "#7c5cff" },
    });
    const parentId = parent.json().id;
    const child = await app.inject({
      method: "POST",
      url: "/api/v1/categories",
      headers: auth,
      payload: { name: "401(k)", color: "#7c5cff", parentCategoryId: parentId },
    });
    const childId = child.json().id;
    const txn = await app.inject({
      method: "POST",
      url: "/api/v1/transactions",
      headers: auth,
      payload: {
        accountId: checkingId,
        pending: false,
        postedAt: `${THIS_MONTH}-15`,
        amountCents: -20_000,
        categoryId: childId,
        merchantName: "Fidelity",
      },
    });
    const txnId = txn.json().id;

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/cashflow/sankey?month=${THIS_MONTH}`,
      headers: auth,
    });
    const body = res.json();
    // Parent aggregates the child's spend and sits one column left of it.
    const parentNode = body.nodes.find((n: { id: string }) => n.id === `cat:${parentId}`);
    expect(parentNode).toMatchObject({ valueCents: 20_000, depth: 2 });
    const childNode = body.nodes.find((n: { id: string }) => n.id === `cat:${childId}`);
    expect(childNode).toMatchObject({ valueCents: 20_000, depth: 3, categoryId: childId });
    expect(body.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "hub", to: `cat:${parentId}`, valueCents: 20_000 }),
        expect.objectContaining({ from: `cat:${parentId}`, to: `cat:${childId}`, valueCents: 20_000 }),
      ]),
    );

    // Clean up so the shared fixture's totals/balances stay intact for later tests.
    await app.inject({ method: "DELETE", url: `/api/v1/transactions/${txnId}`, headers: auth });
    await app.inject({ method: "DELETE", url: `/api/v1/categories/${childId}`, headers: auth });
    await app.inject({ method: "DELETE", url: `/api/v1/categories/${parentId}`, headers: auth });
  });
});

describe("investments", () => {
  it("creates holdings and computes totals + allocation", async () => {
    const vti = await app.inject({
      method: "POST",
      url: `/api/v1/investments/${brokerageId}/holdings`,
      headers: auth,
      payload: {
        symbol: "vti",
        name: "Total Market ETF",
        quantity: "10.5",
        costBasisCents: 200_000,
        marketValueCents: 260_000,
      },
    });
    expect(vti.statusCode).toBe(201);
    expect(vti.json().symbol).toBe("VTI"); // normalized

    await app.inject({
      method: "POST",
      url: `/api/v1/investments/${brokerageId}/holdings`,
      headers: auth,
      payload: { symbol: "BND", quantity: "20", costBasisCents: 150_000, marketValueCents: 140_000 },
    });

    const res = await app.inject({ method: "GET", url: "/api/v1/investments", headers: auth });
    const body = res.json();
    expect(body.totalValueCents).toBe(400_000);
    expect(body.totalCostBasisCents).toBe(350_000);
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0].holdings).toHaveLength(2);
    expect(body.allocation[0]).toMatchObject({ symbol: "VTI", valueCents: 260_000, share: 0.65 });
  });

  it("updates a holding's value and refreshes as-of date", async () => {
    const list = await app.inject({ method: "GET", url: "/api/v1/investments", headers: auth });
    const holding = list.json().accounts[0].holdings.find(
      (h: { symbol: string }) => h.symbol === "BND",
    );
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/holdings/${holding.id}`,
      headers: auth,
      payload: { marketValueCents: 145_000 },
    });
    expect(res.json().marketValueCents).toBe(145_000);
    expect(res.json().asOfDate).toBe(new Date().toISOString().slice(0, 10));

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/holdings/${holding.id}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(204);
  });

  it("rejects holdings on a non-investment account", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/investments/${checkingId}/holdings`,
      headers: auth,
      payload: { symbol: "X", quantity: "1", marketValueCents: 100 },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("goals", () => {
  it("creates a manual goal and a linked goal deriving saved from balance", async () => {
    const manual = await app.inject({
      method: "POST",
      url: "/api/v1/goals",
      headers: auth,
      payload: { name: "Vacation", targetCents: 300_000, savedCents: 90_000, color: "#43cfc0" },
    });
    expect(manual.statusCode).toBe(201);
    expect(manual.json()).toMatchObject({ savedCents: 90_000, projectedCompletion: null });

    // Checking balance = 4000+4000-500-300 = 7200.00; inflow last 90d is positive.
    const linked = await app.inject({
      method: "POST",
      url: "/api/v1/goals",
      headers: auth,
      payload: {
        name: "Emergency Fund",
        targetCents: 1_500_000,
        linkedAccountId: checkingId,
        color: "#3ecf8e",
      },
    });
    const body = linked.json();
    expect(body.savedCents).toBe(720_000); // derived from the account
    expect(body.projectedCompletion).toMatchObject(/^\d{4}-\d{2}$/ as never);
  });

  it("lists, updates, deletes goals", async () => {
    const list = await app.inject({ method: "GET", url: "/api/v1/goals", headers: auth });
    expect(list.json().goals).toHaveLength(2);

    const vacation = list.json().goals.find((g: { name: string }) => g.name === "Vacation");
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/goals/${vacation.id}`,
      headers: auth,
      payload: { savedCents: 120_000 },
    });
    expect(patched.json().savedCents).toBe(120_000);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/goals/${vacation.id}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(204);
  });
});

describe("reports", () => {
  it("builds a monthly report with top categories (AI off → null summary)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly?month=${LAST_MONTH}`,
      headers: auth,
    });
    const body = res.json();
    expect(body).toMatchObject({
      month: LAST_MONTH,
      incomeCents: 400_000,
      spendingCents: 50_000,
      savedCents: 350_000,
      savingsRate: 0.875,
      aiSummary: null, // AI disabled — report still fully usable
    });
    expect(body.topCategories[0]).toMatchObject({ name: "Groceries", spentCents: 50_000 });
  });

  it("builds a yearly report", async () => {
    const year = Number(THIS_MONTH.slice(0, 4));
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/yearly?year=${year}`,
      headers: auth,
    });
    const body = res.json();
    expect(body.months).toHaveLength(12);
    // Totals only include months of this year — both test months qualify
    // unless January (then last month fell in the prior year).
    const expectedIncome = LAST_MONTH.startsWith(String(year)) ? 800_000 : 400_000;
    expect(body.totalIncomeCents).toBe(expectedIncome);
  });

  it("exports transactions as CSV", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/export/csv?type=transactions",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const lines = res.payload.trim().split("\n");
    expect(lines[0]).toBe("date,merchant,amount,category,account,description");
    expect(lines).toHaveLength(5); // header + 4 transactions
    expect(lines[1]).toContain("Payroll");
    expect(lines[1]).toContain("4000.00");
  });
});
