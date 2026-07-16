import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import {
  accounts,
  budgets,
  categories,
  transactions,
} from "../../db/schema.js";
import type { Db } from "../../plugins/db.js";

function dollars(cents: number): string {
  const abs = (Math.abs(cents) / 100).toFixed(2);
  return `${cents < 0 ? "-" : ""}$${abs}`;
}

/**
 * Build the system prompt for a chat turn: role instructions plus a compact
 * snapshot of the household's real data (accounts, month-to-date spending,
 * budgets, recent transactions). Every AI feature in the app is this prompt
 * plus a user message — there are no per-feature model calls (api-design.md).
 *
 * The snapshot is intentionally bounded (~2KB) so small local models keep
 * their context for the conversation itself.
 */
export async function buildFinancialContext(db: Db): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const monthFirst = `${today.slice(0, 7)}-01`;
  const [y, m] = today.slice(0, 7).split("-").map(Number) as [number, number];
  const nextMonthFirst =
    m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;

  const accountRows = await db.query.accounts.findMany({
    where: isNull(accounts.archivedAt),
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });

  const categoryRows = await db.query.categories.findMany();
  const categoryName = new Map(categoryRows.map((c) => [c.id, c.name]));

  const monthByCategory = await db
    .select({
      categoryId: transactions.categoryId,
      spent: sql<string>`coalesce(sum(-${transactions.amountCents}) filter (where ${transactions.amountCents} < 0), 0)`,
      income: sql<string>`coalesce(sum(${transactions.amountCents}) filter (where ${transactions.amountCents} > 0), 0)`,
    })
    .from(transactions)
    .where(
      and(gte(transactions.postedAt, monthFirst), lt(transactions.postedAt, nextMonthFirst)),
    )
    .groupBy(transactions.categoryId);

  const budgetRows = await db
    .select()
    .from(budgets)
    .where(sql`${budgets.startsOn} <= ${monthFirst}`)
    .orderBy(budgets.categoryId, sql`${budgets.startsOn} desc`);
  const latestBudget = new Map<string, (typeof budgetRows)[number]>();
  for (const b of budgetRows) {
    if (!latestBudget.has(b.categoryId)) latestBudget.set(b.categoryId, b);
  }

  const recent = await db
    .select()
    .from(transactions)
    .orderBy(desc(transactions.postedAt), desc(transactions.id))
    .limit(15);

  const lines: string[] = [];

  lines.push(`Today is ${today}.`);
  lines.push("");
  lines.push("ACCOUNTS (name | type | balance):");
  if (accountRows.length === 0) {
    lines.push("  (none yet)");
  }
  for (const a of accountRows) {
    lines.push(`  ${a.name} | ${a.type} | ${dollars(a.balanceCents)}`);
  }
  const netWorth = accountRows.reduce((sum, a) => sum + a.balanceCents, 0);
  lines.push(`  Net worth: ${dollars(netWorth)}`);

  const totalSpent = monthByCategory.reduce((sum, r) => sum + Number(r.spent), 0);
  const totalIncome = monthByCategory.reduce((sum, r) => sum + Number(r.income), 0);
  lines.push("");
  lines.push(
    `THIS MONTH so far: income ${dollars(totalIncome)}, spending ${dollars(totalSpent)}.`,
  );
  const spenders = monthByCategory
    .filter((r) => Number(r.spent) > 0)
    .sort((a, b) => Number(b.spent) - Number(a.spent))
    .slice(0, 10);
  if (spenders.length > 0) {
    lines.push("Spending by category this month:");
    for (const r of spenders) {
      const name = r.categoryId ? (categoryName.get(r.categoryId) ?? "Unknown") : "Uncategorized";
      lines.push(`  ${name}: ${dollars(Number(r.spent))}`);
    }
  }

  if (latestBudget.size > 0) {
    lines.push("");
    lines.push("BUDGETS this month (category | budget | spent so far):");
    const spentByCat = new Map(
      monthByCategory.map((r) => [r.categoryId ?? "none", Number(r.spent)]),
    );
    for (const b of latestBudget.values()) {
      const name = categoryName.get(b.categoryId) ?? "Unknown";
      lines.push(
        `  ${name} | ${dollars(b.amountCents)} | ${dollars(spentByCat.get(b.categoryId) ?? 0)}`,
      );
    }
  }

  if (recent.length > 0) {
    lines.push("");
    lines.push("RECENT TRANSACTIONS (date | merchant | amount | category):");
    for (const t of recent) {
      const name = t.categoryId ? (categoryName.get(t.categoryId) ?? "?") : "Uncategorized";
      lines.push(
        `  ${t.postedAt} | ${t.merchantName.slice(0, 40)} | ${dollars(t.amountCents)} | ${name}`,
      );
    }
  }

  return [
    "You are the AI advisor built into Vault Finance, a self-hosted personal",
    "finance app. You run locally on the household's own server; their data",
    "never leaves their hardware. Answer questions about their finances using",
    "ONLY the snapshot below — never invent accounts, transactions, or numbers",
    "that aren't in it. Negative amounts are money out; positive are money in.",
    "Be concise and concrete: lead with the number or answer, then at most a",
    "few sentences of context. Plain text only — no markdown headers or tables.",
    "If the snapshot doesn't contain what's needed, say so plainly.",
    "",
    "=== HOUSEHOLD SNAPSHOT ===",
    ...lines,
    "=== END SNAPSHOT ===",
  ].join("\n");
}
