import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

/**
 * Giving/gift funds, savings contributions, and the Sankey branches they feed —
 * plus the two derived views (subscriptions, insights).
 *
 * The thing worth locking in here is that the diagram and the sections agree:
 * a number edited on the Bills or Giving page has to move the matching branch,
 * and every planned outflow has to be carved out of "Unspent / saved" exactly
 * once. That invariant is easy to break by adding a branch and forgetting the
 * subtraction, which would silently overstate free money.
 */
describe("giving, savings branches and derived views", () => {
  const PG_PORT = 55442;
  let pg: EmbeddedPostgres;
  let app: FastifyInstance;
  let dataDir: string;
  let pgDir: string;
  let auth: { authorization: string };
  let accountId: string;
  let savingsAccountId: string;
  let givingCategoryId: string;

  const post = (url: string, payload: unknown) =>
    app.inject({ method: "POST", url, headers: auth, payload });
  const patch = (url: string, payload: unknown) =>
    app.inject({ method: "PATCH", url, headers: auth, payload });
  const get = (url: string) => app.inject({ method: "GET", url, headers: auth });

  const month = new Date().toISOString().slice(0, 7);
  const day = (d: number) => `${month}-${String(d).padStart(2, "0")}`;

  interface Node {
    id: string;
    label: string;
    valueCents: number;
    depth: number;
    section?: string;
    entityId?: string | null;
    accountId?: string | null;
    editableMonthlyCents?: number | null;
  }
  const sankey = async (): Promise<{ nodes: Node[]; links: { from: string; to: string; valueCents: number }[] }> =>
    (await get(`/api/v1/cashflow/sankey?month=${month}`)).json();
  const nodeById = (nodes: Node[], id: string) => nodes.find((n) => n.id === id);

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "vault-m9-data-"));
    pgDir = mkdtempSync(path.join(tmpdir(), "vault-m9-pg-"));
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
        ownerEmail: "sam@sam.home",
        ownerPassword: "correct-horse-battery",
        ownerDisplayName: "Sam",
      },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "sam@sam.home",
        password: "correct-horse-battery",
        deviceName: "T",
        platform: "linux",
      },
    });
    auth = { authorization: `Bearer ${login.json().accessToken}` };

    const cats = await get("/api/v1/categories");
    const byName = new Map(
      cats.json().categories.map((c: { name: string; id: string }) => [c.name, c.id]),
    );
    // Any expense category will do — it only has to exist so "given this year"
    // has something to measure against.
    givingCategoryId = [...byName.values()][0] as string;

    accountId = (
      await post("/api/v1/accounts", { name: "Checking", type: "checking", balanceCents: 0 })
    ).json().id;
    savingsAccountId = (
      await post("/api/v1/accounts", {
        name: "Rainy Day",
        type: "savings",
        balanceCents: 500_00,
      })
    ).json().id;

    // $5,000 of income this month, and nothing else, so every branch below is
    // carved out of a total we control exactly.
    await post("/api/v1/transactions", {
      accountId,
      postedAt: day(1),
      amountCents: 5_000_00,
      merchantName: "Payroll",
      pending: false,
    });
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(pgDir, { recursive: true, force: true });
  });

  it("routes a savings goal's monthly contribution into its own branch", async () => {
    const goal = await post("/api/v1/goals", {
      name: "Emergency fund",
      targetCents: 10_000_00,
      monthlyCents: 400_00,
      linkedAccountId: savingsAccountId,
      color: "#3ecf8e",
    });
    expect(goal.statusCode).toBe(201);
    expect(goal.json().monthlyCents).toBe(400_00);

    const { nodes, links } = await sankey();
    const hub = nodeById(nodes, "savings:hub");
    expect(hub?.valueCents).toBe(400_00);
    expect(hub?.section).toBe("savings");

    const leaf = nodeById(nodes, `goal:${goal.json().id}`);
    expect(leaf).toMatchObject({
      section: "savings",
      entityId: goal.json().id,
      // The linked account rides along so drill-in can show where it lands.
      accountId: savingsAccountId,
      editableMonthlyCents: 400_00,
    });
    expect(links).toContainEqual({ from: "hub", to: "savings:hub", valueCents: 400_00 });
  });

  it("splits giving and gift funds into separate branches", async () => {
    const tithe = await post("/api/v1/giving", {
      name: "Monthly tithe",
      kind: "giving",
      recipient: "Local church",
      monthlyCents: 250_00,
      categoryId: givingCategoryId,
    });
    expect(tithe.statusCode).toBe(201);

    const christmas = await post("/api/v1/giving", {
      name: "Christmas",
      kind: "gift",
      monthlyCents: 100_00,
      targetCents: 1_200_00,
      occasionDate: `${new Date().getUTCFullYear()}-12-24`,
    });
    expect(christmas.statusCode).toBe(201);
    // Needs more per month than planned to be ready in time.
    expect(christmas.json().neededMonthlyCents).toBeGreaterThan(0);

    const list = await get("/api/v1/giving");
    expect(list.json()).toMatchObject({
      monthlyGivingCents: 250_00,
      monthlyGiftCents: 100_00,
    });

    const { nodes } = await sankey();
    expect(nodeById(nodes, "giving:hub")?.valueCents).toBe(250_00);
    expect(nodeById(nodes, "gifts:hub")?.valueCents).toBe(100_00);
    expect(nodeById(nodes, `giving:${tithe.json().id}`)).toMatchObject({
      section: "giving",
      entityId: tithe.json().id,
      editableMonthlyCents: 250_00,
    });
  });

  it("carves every planned outflow out of unspent income exactly once", async () => {
    await post("/api/v1/bills", {
      name: "Rent",
      amountCents: 1_500_00,
      dueDay: 1,
      cadence: "monthly",
    });

    const { nodes } = await sankey();
    const income = nodeById(nodes, "hub")!.valueCents;
    const planned = ["bills:hub", "savings:hub", "giving:hub", "gifts:hub"]
      .map((id) => nodeById(nodes, id)?.valueCents ?? 0)
      .reduce((a, b) => a + b, 0);

    expect(income).toBe(5_000_00);
    expect(planned).toBe(1_500_00 + 400_00 + 250_00 + 100_00);
    // No actual spending transactions, so leftover is income minus the plan.
    expect(nodeById(nodes, "saved")?.valueCents).toBe(income - planned);
  });

  it("reflects an edited amount in the branch it feeds", async () => {
    const fund = (await get("/api/v1/giving")).json().funds.find(
      (f: { name: string }) => f.name === "Monthly tithe",
    );
    const updated = await patch(`/api/v1/giving/${fund.id}`, { monthlyCents: 300_00 });
    expect(updated.statusCode).toBe(200);

    const { nodes } = await sankey();
    expect(nodeById(nodes, "giving:hub")?.valueCents).toBe(300_00);
    expect(nodeById(nodes, `giving:${fund.id}`)?.editableMonthlyCents).toBe(300_00);
  });

  it("tracks set-aside contributions and archives rather than deletes", async () => {
    const fund = (await get("/api/v1/giving")).json().funds.find(
      (f: { name: string }) => f.name === "Christmas",
    );
    const funded = await post(`/api/v1/giving/${fund.id}/contribute`, { deltaCents: 300_00 });
    expect(funded.json().savedCents).toBe(300_00);
    // Contributions can't drive a fund negative.
    const overdrawn = await post(`/api/v1/giving/${fund.id}/contribute`, { deltaCents: -999_00 });
    expect(overdrawn.json().savedCents).toBe(0);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/giving/${fund.id}`,
      headers: auth,
    });
    expect(removed.statusCode).toBe(204);
    expect(
      (await get("/api/v1/giving")).json().funds.some((f: { id: string }) => f.id === fund.id),
    ).toBe(false);
    // Gone from the diagram too.
    expect(nodeById((await sankey()).nodes, "gifts:hub")).toBeUndefined();
  });

  it("detects a regular monthly charge as a subscription", async () => {
    // Twelve monthly charges on the same day, one of them a price rise.
    for (let i = 11; i >= 0; i--) {
      const date = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - i, 14));
      await post("/api/v1/transactions", {
        accountId,
        postedAt: date.toISOString().slice(0, 10),
        amountCents: i === 0 ? -1_599 : -1_299,
        merchantName: "Streamflix",
        pending: false,
      });
    }

    const res = await get("/api/v1/subscriptions");
    expect(res.statusCode).toBe(200);
    const found = res
      .json()
      .subscriptions.find((s: { merchantName: string }) => s.merchantName === "Streamflix");
    expect(found).toBeDefined();
    expect(found.cadence).toBe("monthly");
    expect(found.occurrences).toBeGreaterThanOrEqual(3);
    expect(found.priceIncreaseCents).toBe(300);
    expect(found.stale).toBe(false);
  });

  it("reports insights with the page that resolves each one", async () => {
    const res = await get("/api/v1/insights");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.insights)).toBe(true);
    // Income far exceeds spending here, so the savings-rate win must show up.
    const good = body.insights.find((i: { id: string }) => i.id === "healthy-savings-rate");
    expect(good).toMatchObject({ severity: "good", page: "cashflow" });
    // Every insight names a page the client can actually navigate to.
    for (const insight of body.insights) {
      expect(typeof insight.page).toBe("string");
      expect(insight.page.length).toBeGreaterThan(0);
    }
  });

  it("requires auth on every new endpoint", async () => {
    for (const url of ["/api/v1/giving", "/api/v1/subscriptions", "/api/v1/insights"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
    }
  });
});
