// Seed realistic demo data through the public API (never raw SQL — the seed
// doubles as an integration exercise). Targets the dev stack:
//   node scripts/dev-stack.mjs --fresh   (terminal 1)
//   node scripts/seed-demo.mjs           (terminal 2)
// Idempotent-ish: skips seeding if any account already exists.
const BASE = process.env.VAULT_URL ?? "http://127.0.0.1:8787";
const EMAIL = process.env.VAULT_EMAIL ?? "mason@example.com";
const PASSWORD = process.env.VAULT_PASSWORD ?? "a-long-enough-password";

const api = async (method, path, body, token) => {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
};

// Ensure setup + login.
const { needsSetup } = await api("GET", "/setup/status");
if (needsSetup) {
  await api("POST", "/setup/complete", {
    ownerEmail: EMAIL,
    ownerPassword: PASSWORD,
    ownerDisplayName: "Mason",
  });
  console.log("setup completed");
}
const login = await api("POST", "/auth/login", {
  email: EMAIL,
  password: PASSWORD,
  deviceName: "seed script",
  platform: "linux",
});
const token = login.accessToken;

const existing = await api("GET", "/accounts", null, token);
if (existing.accounts.length > 0) {
  console.log("accounts already exist — not reseeding");
  process.exit(0);
}

const cats = new Map(
  (await api("GET", "/categories", null, token)).categories.map((c) => [c.name, c.id]),
);

// ── Accounts ──
const checking = await api("POST", "/accounts", { name: "Everyday Checking", type: "checking", institution: "First Local", balanceCents: 0 }, token);
const savings = await api("POST", "/accounts", { name: "High-Yield Savings", type: "savings", institution: "First Local", balanceCents: 1_250_000 }, token);
const card = await api("POST", "/accounts", { name: "Travel Card", type: "credit_card", balanceCents: -68_400 }, token);
const brokerage = await api("POST", "/accounts", { name: "Brokerage", type: "investment", institution: "Vanguard", balanceCents: 0 }, token);
console.log("accounts created");

// ── Four months of transactions ──
const month = (delta) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1)).toISOString().slice(0, 7);
};
const txn = (accountId, postedAt, amountCents, merchantName, catName) =>
  api("POST", "/transactions", {
    accountId,
    postedAt,
    amountCents,
    merchantName,
    categoryId: catName ? (cats.get(catName) ?? null) : null,
    pending: false,
  }, token);

for (let delta = -3; delta <= 0; delta++) {
  const m = month(delta);
  const spendScale = 1 + 0.08 * (delta + 3); // spending creeps up over the months
  await txn(checking.id, `${m}-01`, 512_000, "Acme Payroll", "Income");
  await txn(checking.id, `${m}-15`, 87_500, "Freelance Invoice", "Income");
  await txn(checking.id, `${m}-02`, -185_000, "Oakwood Property Mgmt", "Mortgage & Rent");
  await txn(checking.id, `${m}-04`, -Math.round(28_000 * spendScale), "Fresh Market", "Groceries");
  await txn(checking.id, `${m}-12`, -Math.round(24_500 * spendScale), "Corner Grocer", "Groceries");
  await txn(checking.id, `${m}-20`, -Math.round(19_800 * spendScale), "Fresh Market", "Groceries");
  await txn(card.id, `${m}-07`, -Math.round(14_200 * spendScale), "Starbeans & Vine", "Dining Out");
  await txn(card.id, `${m}-18`, -Math.round(11_600 * spendScale), "Noodle House", "Dining Out");
  await txn(checking.id, `${m}-05`, -13_500, "City Power & Light", "Utilities");
  await txn(checking.id, `${m}-06`, -8_900, "Metro Internet", "Utilities");
  await txn(checking.id, `${m}-10`, -32_000, "AutoSure Insurance", "Insurance");
  await txn(card.id, `${m}-14`, -Math.round(9_400 * spendScale), "Gas & Go", "Transport");
  await txn(card.id, `${m}-22`, -Math.round(16_700 * spendScale), "Big Box Store", "Shopping");
  await txn(checking.id, `${m}-25`, -4_800, "StreamFlix", "Subscriptions");
  await txn(checking.id, `${m}-28`, -100_000, "Transfer to Savings", "Savings");
}
console.log("4 months of transactions created");

// ── Budgets ──
const budget = (catName, amountCents) =>
  api("POST", "/budgets", { categoryId: cats.get(catName), amountCents, rollover: false }, token);
await budget("Groceries", 90_000);
await budget("Dining Out", 35_000);
await budget("Transport", 15_000);
await budget("Shopping", 25_000);
await budget("Subscriptions", 6_000);
console.log("budgets created");

// ── Holdings ──
const holding = (body) => api("POST", `/investments/${brokerage.id}/holdings`, body, token);
await holding({ symbol: "VTI", name: "Total Stock Market ETF", quantity: "42.75", costBasisCents: 9_200_00, marketValueCents: 11_830_00 });
await holding({ symbol: "VXUS", name: "International ETF", quantity: "58.2", costBasisCents: 3_310_00, marketValueCents: 3_542_00 });
await holding({ symbol: "BND", name: "Total Bond ETF", quantity: "35", costBasisCents: 2_570_00, marketValueCents: 2_495_00 });
console.log("holdings created");

// ── Goals ──
await api("POST", "/goals", {
  name: "Emergency Fund",
  targetCents: 1_800_000,
  linkedAccountId: savings.id,
  color: "#3ecf8e",
  note: "6 months of expenses",
}, token);
await api("POST", "/goals", {
  name: "Japan Trip",
  targetCents: 550_000,
  savedCents: 210_000,
  targetDate: `${new Date().getUTCFullYear() + 1}-04-01`,
  color: "#ec6a9c",
  note: "flights + two weeks",
}, token);
console.log("goals created");
console.log(`seeded against ${BASE}`);
