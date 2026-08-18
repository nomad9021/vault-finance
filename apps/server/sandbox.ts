/**
 * Throwaway sandbox server for hands-on UI debugging.
 *
 * Boots an embedded Postgres and a server on :8444 with a disposable owner and
 * a spread of seeded data, so the real app can be clicked through without going
 * anywhere near the household's actual database or credentials. Nothing here is
 * shipped — delete when you're done.
 *
 *   pnpm --filter @vault/server exec tsx sandbox.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { buildApp } from "./src/app.js";
import { loadConfig } from "./src/config.js";

const PG_PORT = 55500;
const PORT = 8444;
const EMAIL = "sandbox@example.test";
const PASSWORD = "sandbox-debug-password";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000));
const monthsAgoOn = (m: number, day: number) => {
  const now = new Date();
  return iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, day)));
};

const pgDir = mkdtempSync(path.join(tmpdir(), "vault-sandbox-pg-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "vault-sandbox-data-"));

const pg = new EmbeddedPostgres({
  databaseDir: pgDir,
  user: "vault",
  password: "vault",
  port: PG_PORT,
  persistent: false,
});
await pg.initialise();
await pg.start();
await pg.createDatabase("vault");

const app = await buildApp({
  config: loadConfig({
    DATABASE_URL: `postgres://vault:vault@localhost:${PG_PORT}/vault`,
    VAULT_TLS: "off",
    VAULT_PORT: String(PORT),
    VAULT_DATA_DIR: dataDir,
    LOG_LEVEL: "warn",
  } as NodeJS.ProcessEnv),
});

// ── seed ──
await app.inject({
  method: "POST",
  url: "/api/v1/setup/complete",
  payload: { ownerEmail: EMAIL, ownerPassword: PASSWORD, ownerDisplayName: "Sandbox" },
});
const login = await app.inject({
  method: "POST",
  url: "/api/v1/auth/login",
  payload: { email: EMAIL, password: PASSWORD, deviceName: "seed", platform: "linux" },
});
const auth = { authorization: `Bearer ${login.json().accessToken}` };
const post = (url: string, payload: unknown) =>
  app.inject({ method: "POST", url, headers: auth, payload });

const cats = (await app.inject({ method: "GET", url: "/api/v1/categories", headers: auth })).json();
const catId = (name: string): string | undefined =>
  cats.categories.find((c: { name: string }) => c.name === name)?.id;
const anyExpense = cats.categories.find((c: { kind: string }) => c.kind === "expense")?.id;
const anyIncome = cats.categories.find((c: { kind: string }) => c.kind === "income")?.id;

const acct = async (name: string, type: string, balanceCents: number, isLiability = false) =>
  (await post("/api/v1/accounts", { name, type, balanceCents, isLiability })).json().id;

const checking = await acct("Everyday Checking", "checking", 412_300);
const savings = await acct("Rainy Day Savings", "savings", 8_450_00);
const giftAcct = await acct("Gift Fund", "savings", 240_00);
const card = await acct("Visa Rewards", "credit_card", -1_240_55, true);

const txn = (accountId: string, postedAt: string, amountCents: number, merchantName: string, categoryId?: string) =>
  post("/api/v1/transactions", {
    accountId,
    postedAt,
    amountCents,
    merchantName,
    pending: false,
    ...(categoryId ? { categoryId } : {}),
  });

// Income and spending across the last few months so trends and the Sankey fill.
for (let m = 0; m < 4; m++) {
  await txn(checking, monthsAgoOn(m, 1), 4_200_00, "Acme Payroll", anyIncome);
  await txn(checking, monthsAgoOn(m, 15), 620_00, "Side Consulting", anyIncome);
  await txn(checking, monthsAgoOn(m, 3), -1_450_00, "Landlord", catId("Rent") ?? anyExpense);
  await txn(checking, monthsAgoOn(m, 6), -320_45, "Fresh Market", catId("Groceries") ?? anyExpense);
  await txn(checking, monthsAgoOn(m, 9), -88_20, "Corner Diner", catId("Dining Out") ?? anyExpense);
  await txn(card, monthsAgoOn(m, 11), -142_30, "Fuel Stop", anyExpense);
  await txn(checking, monthsAgoOn(m, 18), -64_00, "City Power", anyExpense);
  // An uncategorized run, so the "uncategorized" insight has something to say.
  await txn(card, monthsAgoOn(m, 20), -31_99, `Sundry Purchase ${m}`);
}
// A regular monthly charge with a price rise on the latest one → subscription.
for (let m = 11; m >= 0; m--) {
  await txn(checking, monthsAgoOn(m, 14), m === 0 ? -17_99 : -14_99, "Streamflix");
}
for (let m = 11; m >= 0; m--) {
  await txn(checking, monthsAgoOn(m, 22), -9_99, "Cloud Backup Co");
}
// Stopped charging six months ago → "possibly cancelled".
for (let m = 11; m >= 6; m--) {
  await txn(card, monthsAgoOn(m, 8), -12_50, "Gym Membership");
}

const today = new Date().getUTCDate();
await post("/api/v1/bills", {
  name: "Rent", amountCents: 1_450_00, savedCents: 1_450_00,
  dueDay: 1, cadence: "monthly", categoryId: catId("Rent") ?? anyExpense, accountId: checking,
});
await post("/api/v1/bills", {
  name: "Car Insurance", amountCents: 780_00, savedCents: 130_00,
  dueDay: Math.min(28, today + 3), cadence: "quarterly", color: "#e0a458",
});
await post("/api/v1/bills", {
  name: "Broadband", amountCents: 62_00, savedCents: 0,
  dueDay: Math.min(28, today + 1), cadence: "monthly", autopay: false, color: "#4db6d0",
});
await post("/api/v1/bills", {
  name: "Phone", amountCents: 45_00, savedCents: 45_00, dueDay: 20, cadence: "monthly", autopay: true,
});

await post("/api/v1/goals", {
  name: "Emergency Fund", targetCents: 15_000_00, monthlyCents: 400_00,
  linkedAccountId: savings, color: "#3ecf8e", note: "Three months of expenses",
});
await post("/api/v1/goals", {
  name: "New Laptop", targetCents: 2_400_00, savedCents: 600_00, monthlyCents: 150_00,
  targetDate: iso(new Date(Date.now() + 120 * 86_400_000)), color: "#6f8ef2",
});
await post("/api/v1/goals", {
  name: "Someday Trip", targetCents: 5_000_00, savedCents: 250_00, monthlyCents: 0, color: "#b47ef0",
});

await post("/api/v1/giving", {
  name: "Monthly Tithe", kind: "giving", recipient: "Local church",
  monthlyCents: 300_00, categoryId: anyExpense, color: "#b47ef0",
});
await post("/api/v1/giving", {
  name: "Food Bank", kind: "giving", recipient: "City food bank", monthlyCents: 50_00, color: "#3ecf8e",
});
await post("/api/v1/giving", {
  name: "Christmas", kind: "gift", monthlyCents: 60_00, targetCents: 1_200_00,
  occasionDate: iso(new Date(Date.now() + 100 * 86_400_000)), accountId: giftAcct, color: "#ec6a9c",
});
await post("/api/v1/giving", {
  name: "Mum's Birthday", kind: "gift", recipient: "Mum", monthlyCents: 25_00,
  targetCents: 150_00, savedCents: 40_00,
  occasionDate: iso(new Date(Date.now() + 45 * 86_400_000)), color: "#d8b23c",
});

const budgetMonth = new Date().toISOString().slice(0, 7);
for (const [name, amount] of [["Groceries", 400_00], ["Dining Out", 120_00], ["Rent", 1_450_00]] as const) {
  const id = catId(name);
  if (id) await post("/api/v1/budgets", { categoryId: id, amountCents: amount, startsOn: `${budgetMonth}-01` });
}

await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`sandbox ready on http://localhost:${PORT}  (${EMAIL} / ${PASSWORD})`);
console.log(`accounts: checking=${checking} savings=${savings} card=${card} daysAgo=${daysAgo(1)}`);
