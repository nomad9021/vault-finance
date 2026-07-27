import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

/** M3: accounts, categories, transactions (search/pagination/import), budgets. */

const PG_PORT = 55435;
let pg: EmbeddedPostgres;
let app: FastifyInstance;
let dataDir: string;
let pgDir: string;
let auth: { authorization: string };

let checkingId: string;
let savingsId: string;
let groceriesId: string;
let diningId: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "vault-m3-data-"));
  pgDir = mkdtempSync(path.join(tmpdir(), "vault-m3-pg-"));

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

  const cats = await app.inject({ method: "GET", url: "/api/v1/categories", headers: auth });
  const byName = new Map(
    cats.json().categories.map((c: { name: string; id: string }) => [c.name, c.id]),
  );
  groceriesId = byName.get("Groceries") as string;
  diningId = byName.get("Dining Out") as string;
});

afterAll(async () => {
  await app?.close();
  await pg?.stop();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(pgDir, { recursive: true, force: true });
});

describe("accounts", () => {
  it("requires auth", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/accounts" });
    expect(res.statusCode).toBe(401);
  });

  it("creates accounts and derives liability flag from type", async () => {
    const checking = await app.inject({
      method: "POST",
      url: "/api/v1/accounts",
      headers: auth,
      payload: {
        name: "Everyday Checking",
        type: "checking",
        balanceCents: 250_000,
        institution: "First Local",
      },
    });
    expect(checking.statusCode).toBe(201);
    expect(checking.json().isLiability).toBe(false);
    checkingId = checking.json().id;

    const savings = await app.inject({
      method: "POST",
      url: "/api/v1/accounts",
      headers: auth,
      payload: { name: "Emergency Fund", type: "savings", balanceCents: 1_200_000 },
    });
    savingsId = savings.json().id;

    const card = await app.inject({
      method: "POST",
      url: "/api/v1/accounts",
      headers: auth,
      payload: { name: "Travel Card", type: "credit_card", balanceCents: -45_000 },
    });
    expect(card.json().isLiability).toBe(true);
  });

  it("lists, updates, and hard-deletes when empty", async () => {
    const list = await app.inject({ method: "GET", url: "/api/v1/accounts", headers: auth });
    expect(list.json().accounts).toHaveLength(3);

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/accounts/${savingsId}`,
      headers: auth,
      payload: { name: "Rainy-Day Fund" },
    });
    expect(patch.json().name).toBe("Rainy-Day Fund");

    // No transactions yet → hard delete; then recreate for later tests.
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/accounts/${savingsId}`,
      headers: auth,
    });
    expect(del.json()).toEqual({ archived: false });
    const recreated = await app.inject({
      method: "POST",
      url: "/api/v1/accounts",
      headers: auth,
      payload: { name: "Emergency Fund", type: "savings", balanceCents: 1_200_000 },
    });
    savingsId = recreated.json().id;
  });
});

describe("transactions", () => {
  it("creates transactions and moves the account balance", async () => {
    const t1 = await app.inject({
      method: "POST",
      url: "/api/v1/transactions",
      headers: auth,
      payload: {
        accountId: checkingId,
        categoryId: groceriesId,
        postedAt: "2026-07-01",
        amountCents: -8_450,
        merchantName: "Fresh Market",
      },
    });
    expect(t1.statusCode).toBe(201);

    await app.inject({
      method: "POST",
      url: "/api/v1/transactions",
      headers: auth,
      payload: {
        accountId: checkingId,
        categoryId: diningId,
        postedAt: "2026-07-03",
        amountCents: -3_200,
        merchantName: "Starbeans Coffee",
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/transactions",
      headers: auth,
      payload: {
        accountId: checkingId,
        postedAt: "2026-07-05",
        amountCents: 425_000,
        merchantName: "Acme Payroll",
      },
    });

    const account = await app.inject({
      method: "GET",
      url: `/api/v1/accounts/${checkingId}`,
      headers: auth,
    });
    expect(account.json().balanceCents).toBe(250_000 - 8_450 - 3_200 + 425_000);
  });

  it("searches merchants with prefix matching", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/transactions?search=starb",
      headers: auth,
    });
    expect(res.json().totalCount).toBe(1);
    expect(res.json().transactions[0].merchantName).toBe("Starbeans Coffee");
  });

  it("filters by category and paginates with a cursor", async () => {
    const byCat = await app.inject({
      method: "GET",
      url: `/api/v1/transactions?categoryId=${groceriesId}`,
      headers: auth,
    });
    expect(byCat.json().totalCount).toBe(1);

    const uncategorized = await app.inject({
      method: "GET",
      url: "/api/v1/transactions?categoryId=none",
      headers: auth,
    });
    expect(uncategorized.json().transactions[0].merchantName).toBe("Acme Payroll");

    const page1 = await app.inject({
      method: "GET",
      url: "/api/v1/transactions?limit=2",
      headers: auth,
    });
    expect(page1.json().transactions).toHaveLength(2);
    expect(page1.json().nextCursor).toBeTruthy();
    expect(page1.json().totalCount).toBe(3);

    const page2 = await app.inject({
      method: "GET",
      url: `/api/v1/transactions?limit=2&cursor=${encodeURIComponent(page1.json().nextCursor)}`,
      headers: auth,
    });
    expect(page2.json().transactions).toHaveLength(1);
    expect(page2.json().nextCursor).toBeNull();
    // Newest first, no overlap across pages.
    const ids = [...page1.json().transactions, ...page2.json().transactions].map(
      (t: { id: string }) => t.id,
    );
    expect(new Set(ids).size).toBe(3);
  });

  it("re-categorizes and adjusts balance on amount edit", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/transactions?search=starbeans",
      headers: auth,
    });
    const txn = list.json().transactions[0];

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/transactions/${txn.id}`,
      headers: auth,
      payload: { categoryId: groceriesId, amountCents: -3_500 },
    });
    expect(patched.json().categoryId).toBe(groceriesId);

    const account = await app.inject({
      method: "GET",
      url: `/api/v1/accounts/${checkingId}`,
      headers: auth,
    });
    expect(account.json().balanceCents).toBe(250_000 - 8_450 - 3_500 + 425_000);
  });

  it("imports CSV with dedupe and reports bad rows", async () => {
    const csv = [
      "date,merchant,amount,category,description",
      "2026-07-08,Corner Grocer,-23.75,Groceries,weekly shop",
      "2026-07-08,Corner Grocer,-23.75,Groceries,identical twin — kept",
      "2026-07-09,Gas & Go,-40.00,,fill up",
      "not-a-date,Broken Row,-1.00,,",
    ].join("\n");

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/transactions/import",
      headers: auth,
      payload: { accountId: checkingId, csv },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ imported: 3, skippedDuplicates: 0 });
    expect(first.json().errors).toHaveLength(1);
    expect(first.json().errors[0].line).toBe(5);

    // Re-importing the identical file is a no-op.
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/transactions/import",
      headers: auth,
      payload: { accountId: checkingId, csv },
    });
    expect(second.json()).toMatchObject({ imported: 0, skippedDuplicates: 3 });

    // Category column matched by name.
    const groceries = await app.inject({
      method: "GET",
      url: `/api/v1/transactions?categoryId=${groceriesId}&search=corner`,
      headers: auth,
    });
    expect(groceries.json().totalCount).toBe(2);
  });

  it("deletes a transaction and restores the balance", async () => {
    const gas = await app.inject({
      method: "GET",
      url: "/api/v1/transactions?search=gas",
      headers: auth,
    });
    const before = (
      await app.inject({
        method: "GET",
        url: `/api/v1/accounts/${checkingId}`,
        headers: auth,
      })
    ).json().balanceCents;

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/transactions/${gas.json().transactions[0].id}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(204);

    const after = (
      await app.inject({
        method: "GET",
        url: `/api/v1/accounts/${checkingId}`,
        headers: auth,
      })
    ).json().balanceCents;
    expect(after).toBe(before + 4_000);
  });

  it("archives (not deletes) an account that has transactions", async () => {
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/accounts/${checkingId}`,
      headers: auth,
    });
    expect(del.json()).toEqual({ archived: true });

    const list = await app.inject({ method: "GET", url: "/api/v1/accounts", headers: auth });
    expect(
      list.json().accounts.find((a: { id: string }) => a.id === checkingId),
    ).toBeUndefined();

    // Unarchive for the budget tests.
    await app.inject({
      method: "PATCH",
      url: `/api/v1/accounts/${checkingId}`,
      headers: auth,
      payload: { archived: false },
    });
  });
});

describe("categories", () => {
  it("creates custom categories; blocks deleting system or in-use ones", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/categories",
      headers: auth,
      payload: { name: "Pet Care", color: "#43cfc0" },
    });
    expect(created.statusCode).toBe(201);

    const delSystem = await app.inject({
      method: "DELETE",
      url: `/api/v1/categories/${groceriesId}`,
      headers: auth,
    });
    expect(delSystem.statusCode).toBe(409);
    expect(delSystem.json().error.code).toBe("CATEGORY_IN_USE");

    const delUnused = await app.inject({
      method: "DELETE",
      url: `/api/v1/categories/${created.json().id}`,
      headers: auth,
    });
    expect(delUnused.statusCode).toBe(204);
  });

  it("reorders siblings with move up/down (and clamps at the ends)", async () => {
    // Isolate the siblings under a fresh parent so seeded top-level cats don't
    // interfere with the ordering assertions.
    const parent = await app.inject({
      method: "POST",
      url: "/api/v1/categories",
      headers: auth,
      payload: { name: "ZZ Order Parent", color: "#43cfc0" },
    });
    const parentId = parent.json().id as string;
    const mk = async (name: string) => {
      const r = await app.inject({
        method: "POST",
        url: "/api/v1/categories",
        headers: auth,
        payload: { name, color: "#43cfc0", parentCategoryId: parentId },
      });
      return r.json().id as string;
    };
    const a = await mk("A");
    const b = await mk("B");
    const c = await mk("C");
    // Ordered ids of this parent's children, by sortOrder.
    const order = (cats: { id: string; parentCategoryId: string | null; sortOrder: number }[]) =>
      cats
        .filter((x) => x.parentCategoryId === parentId)
        .sort((x, y) => x.sortOrder - y.sortOrder)
        .map((x) => x.id);

    const move = (id: string, direction: "up" | "down") =>
      app.inject({
        method: "POST",
        url: `/api/v1/categories/${id}/move`,
        headers: auth,
        payload: { direction },
      });

    // Created in append order.
    let list = (await move(c, "down")).json().categories; // C already last → no-op
    expect(order(list)).toEqual([a, b, c]);

    // Move B up → [B, A, C].
    list = (await move(b, "up")).json().categories;
    expect(order(list)).toEqual([b, a, c]);

    // Move B up again is clamped (already first) → unchanged.
    list = (await move(b, "up")).json().categories;
    expect(order(list)).toEqual([b, a, c]);

    // Move B down → [A, B, C].
    list = (await move(b, "down")).json().categories;
    expect(order(list)).toEqual([a, b, c]);

    for (const id of [a, b, c, parentId]) {
      await app.inject({ method: "DELETE", url: `/api/v1/categories/${id}`, headers: auth });
    }
  });
});

describe("budgets", () => {
  it("creates budgets and joins month spending", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/budgets",
      headers: auth,
      payload: { categoryId: groceriesId, amountCents: 60_000, month: "2026-07" },
    });
    expect(res.statusCode).toBe(201);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/budgets?month=2026-07",
      headers: auth,
    });
    const body = list.json();
    expect(body.month).toBe("2026-07");
    expect(body.budgets).toHaveLength(1);
    // Groceries spending in July: 8450 + 3500 (recategorized) + 2375×2 (import)
    expect(body.budgets[0].spentCents).toBe(8_450 + 3_500 + 2_375 * 2);
    expect(body.totalBudgetedCents).toBe(60_000);
  });

  it("applies the latest budget to later months", async () => {
    const aug = await app.inject({
      method: "GET",
      url: "/api/v1/budgets?month=2026-08",
      headers: auth,
    });
    expect(aug.json().budgets).toHaveLength(1);
    expect(aug.json().budgets[0].spentCents).toBe(0); // no August spending

    const june = await app.inject({
      method: "GET",
      url: "/api/v1/budgets?month=2026-06",
      headers: auth,
    });
    expect(june.json().budgets).toHaveLength(0); // budget starts in July
  });

  it("updates and deletes a budget", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/budgets?month=2026-07",
      headers: auth,
    });
    const budget = list.json().budgets[0];

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/budgets/${budget.id}`,
      headers: auth,
      payload: { amountCents: 65_000 },
    });
    expect(patched.json().amountCents).toBe(65_000);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/budgets/${budget.id}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(204);
  });
});
