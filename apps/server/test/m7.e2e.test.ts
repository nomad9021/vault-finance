import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  learnFromHistory,
  matchExplicitRule,
  normalizeMerchant,
  suggestCategory,
} from "../src/modules/categorize/engine.js";

/** Phase 2: local-rules auto-categorization — engine + endpoints. */

describe("categorize engine (pure)", () => {
  it("normalizes noisy merchant strings", () => {
    expect(normalizeMerchant("SQ *Blue Bottle #1234")).toBe("SQ BLUE BOTTLE");
    expect(normalizeMerchant("  amazon.com*A1B2  ")).toBe("AMAZON COM A B");
  });

  it("learns the most-frequent category per merchant", () => {
    const learned = learnFromHistory([
      { merchantName: "Fresh Market", categoryId: "groceries" },
      { merchantName: "FRESH MARKET", categoryId: "groceries" },
      { merchantName: "Fresh Market", categoryId: "dining" },
      { merchantName: "Payroll", categoryId: null },
    ]);
    expect(learned.get("FRESH MARKET")).toBe("groceries");
    expect(learned.has("PAYROLL")).toBe(false);
  });

  it("matches explicit rules by priority then specificity", () => {
    const rules = [
      { keyword: "coffee", categoryId: "dining", priority: 0 },
      { keyword: "blue bottle coffee", categoryId: "coffee-cat", priority: 0 },
      { keyword: "market", categoryId: "misc", priority: 5 },
    ];
    // Higher priority wins outright.
    expect(matchExplicitRule("Fresh Market", rules)).toBe("misc");
    // Same priority → longer (more specific) keyword wins.
    expect(matchExplicitRule("Blue Bottle Coffee Co", rules)).toBe("coffee-cat");
    expect(matchExplicitRule("Unknown Vendor", rules)).toBeNull();
  });

  it("prefers explicit rules over learned history", () => {
    const learned = new Map([[normalizeMerchant("Starbeans & Vine"), "history-cat"]]);
    const rules = [{ keyword: "starbeans", categoryId: "rule-cat", priority: 0 }];
    expect(suggestCategory("Starbeans & Vine", rules, learned)).toEqual({
      categoryId: "rule-cat",
      source: "rule",
    });
    expect(suggestCategory("Starbeans & Vine", [], learned)).toEqual({
      categoryId: "history-cat",
      source: "history",
    });
    expect(suggestCategory("Nowhere", [], learned)).toBeNull();
  });
});

describe("auto-categorization endpoints", () => {
  const PG_PORT = 55440;
  let pg: EmbeddedPostgres;
  let app: FastifyInstance;
  let dataDir: string;
  let pgDir: string;
  let auth: { authorization: string };
  let accountId: string;
  let groceriesId: string;
  let diningId: string;

  const post = (url: string, payload: unknown) =>
    app.inject({ method: "POST", url, headers: auth, payload });

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "vault-m7-data-"));
    pgDir = mkdtempSync(path.join(tmpdir(), "vault-m7-pg-"));
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
      payload: { email: "sam@sam.home", password: "correct-horse-battery", deviceName: "T", platform: "linux" },
    });
    auth = { authorization: `Bearer ${login.json().accessToken}` };

    const cats = await app.inject({ method: "GET", url: "/api/v1/categories", headers: auth });
    const byName = new Map(
      cats.json().categories.map((c: { name: string; id: string }) => [c.name, c.id]),
    );
    groceriesId = byName.get("Groceries") as string;
    diningId = byName.get("Dining Out") as string;

    const acct = await post("/api/v1/accounts", { name: "Checking", type: "checking", balanceCents: 0 });
    accountId = acct.json().id;

    // History the engine can learn from: Fresh Market → Groceries, twice.
    for (const n of [1, 2]) {
      await post("/api/v1/transactions", {
        accountId,
        postedAt: `2026-05-0${n}`,
        amountCents: -2500,
        merchantName: "Fresh Market",
        categoryId: groceriesId,
        pending: false,
      });
    }
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(pgDir, { recursive: true, force: true });
  });

  it("assigns rules and sweeps uncategorized transactions", async () => {
    // Explicit rule: anything mentioning "Starbeans" is Dining Out.
    const rule = await post("/api/v1/categorization-rules", {
      keyword: "Starbeans",
      categoryId: diningId,
    });
    expect(rule.statusCode).toBe(201);

    // Two uncategorized transactions: one the rule covers, one only history covers.
    await post("/api/v1/transactions", {
      accountId,
      postedAt: "2026-06-01",
      amountCents: -1800,
      merchantName: "Starbeans & Vine",
      pending: false,
    });
    await post("/api/v1/transactions", {
      accountId,
      postedAt: "2026-06-02",
      amountCents: -3100,
      merchantName: "Fresh Market #22",
      pending: false,
    });

    const res = await post("/api/v1/transactions/autocategorize", {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ scanned: 2, categorized: 2, byRule: 1, byHistory: 1 });

    // Confirm the assignments actually landed.
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/transactions?limit=50",
      headers: auth,
    });
    const txns = list.json().transactions as { merchantName: string; categoryId: string | null }[];
    const starbeans = txns.find((t) => t.merchantName === "Starbeans & Vine");
    const freshMkt22 = txns.find((t) => t.merchantName === "Fresh Market #22");
    expect(starbeans?.categoryId).toBe(diningId);
    expect(freshMkt22?.categoryId).toBe(groceriesId);

    // Idempotent: nothing left uncategorized to touch.
    const again = await post("/api/v1/transactions/autocategorize", {});
    expect(again.json()).toMatchObject({ scanned: 0, categorized: 0 });

    await app.inject({
      method: "DELETE",
      url: `/api/v1/categorization-rules/${rule.json().id}`,
      headers: auth,
    });
  });

  it("auto-categorizes rows during CSV import", async () => {
    // "Fresh Market #7" normalizes to "FRESH MARKET", matching the history;
    // the mystery vendor matches nothing and stays uncategorized.
    const csv = "date,merchant,amount\n2026-06-10,Fresh Market #7,-42.00\n2026-06-11,Total Mystery Vendor,-9.00";
    const res = await post("/api/v1/transactions/import", { accountId, csv });
    expect(res.statusCode).toBe(200);
    expect(res.json().imported).toBe(2);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/transactions?limit=50",
      headers: auth,
    });
    const txns = list.json().transactions as { merchantName: string; categoryId: string | null }[];
    expect(txns.find((t) => t.merchantName === "Fresh Market #7")?.categoryId).toBe(groceriesId);
    expect(txns.find((t) => t.merchantName === "Total Mystery Vendor")?.categoryId).toBeNull();
  });
});
