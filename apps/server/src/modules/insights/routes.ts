import type { Insight, InsightListResponse } from "@vault/shared";
import { and, gte, isNull, lt, lte, notInArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  accounts,
  bills,
  budgets,
  categories,
  givingFunds,
  savingsGoals,
  transactions,
} from "../../db/schema.js";
import { daysUntilDue } from "../bills/due.js";

/**
 * Rule-based insights.
 *
 * Deliberately not AI: these have to be explainable ("you budgeted $400 and
 * spent $612"), reproducible, and available on a server where no AI provider is
 * configured — which is the default. Every rule below is a plain comparison
 * over data the app already stores, and every insight names the page that fixes
 * it so the card can carry a button straight there.
 */

function monthBounds(month: string): { first: string; nextFirst: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return { first: `${month}-01`, nextFirst: `${next}-01` };
}

function money(cents: number): string {
  return `$${(Math.abs(cents) / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2, good: 3 } as const;

export default async function insightRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireAuth);

  app.get("/insights", async (): Promise<InsightListResponse> => {
    const month = new Date().toISOString().slice(0, 7);
    const { first, nextFirst } = monthBounds(month);
    const insights: Insight[] = [];

    const accts = await app.db.select().from(accounts);
    const active = accts.filter((a) => !a.archivedAt);
    const archivedIds = accts.filter((a) => a.archivedAt).map((a) => a.id);
    const notArchived = archivedIds.length
      ? notInArray(transactions.accountId, archivedIds)
      : undefined;

    // ── this month's flows ──
    const [flow] = await app.db
      .select({
        income: sql<string>`coalesce(sum(${transactions.amountCents}) filter (where ${transactions.amountCents} > 0), 0)`,
        spending: sql<string>`coalesce(sum(-${transactions.amountCents}) filter (where ${transactions.amountCents} < 0), 0)`,
      })
      .from(transactions)
      .where(and(gte(transactions.postedAt, first), lt(transactions.postedAt, nextFirst), notArchived));
    const incomeCents = Number(flow?.income ?? 0);
    const spendingCents = Number(flow?.spending ?? 0);

    if (incomeCents > 0 && spendingCents > incomeCents) {
      insights.push({
        id: "spending-over-income",
        severity: "critical",
        title: "Spending more than you earned this month",
        detail: `You've spent ${money(spendingCents)} against ${money(incomeCents)} of income — ${money(spendingCents - incomeCents)} more than came in.`,
        page: "cashflow",
        categoryId: null,
        accountId: null,
        amountCents: spendingCents - incomeCents,
      });
    } else if (incomeCents > 0 && spendingCents > 0) {
      const rate = (incomeCents - spendingCents) / incomeCents;
      if (rate >= 0.2) {
        insights.push({
          id: "healthy-savings-rate",
          severity: "good",
          title: `Keeping ${Math.round(rate * 100)}% of your income`,
          detail: `${money(incomeCents - spendingCents)} of this month's ${money(incomeCents)} hasn't gone out. Anything above 20% is a strong month.`,
          page: "cashflow",
          categoryId: null,
          accountId: null,
          amountCents: incomeCents - spendingCents,
        });
      }
    }

    // ── budgets overspent ──
    const budgetRows = await app.db
      .select()
      .from(budgets)
      .where(lte(budgets.startsOn, first))
      .orderBy(budgets.categoryId, sql`${budgets.startsOn} desc`);
    const latestBudget = new Map<string, typeof budgets.$inferSelect>();
    for (const b of budgetRows) if (!latestBudget.has(b.categoryId)) latestBudget.set(b.categoryId, b);

    const spentRows = await app.db
      .select({
        categoryId: transactions.categoryId,
        spent: sql<string>`coalesce(sum(-${transactions.amountCents}) filter (where ${transactions.amountCents} < 0), 0)`,
      })
      .from(transactions)
      .where(and(gte(transactions.postedAt, first), lt(transactions.postedAt, nextFirst), notArchived))
      .groupBy(transactions.categoryId);
    const spentByCategory = new Map(spentRows.map((r) => [r.categoryId ?? "none", Number(r.spent)]));

    const cats = await app.db.select().from(categories);
    const catName = new Map(cats.map((c) => [c.id, c.name]));

    for (const [categoryId, budget] of latestBudget) {
      const spent = spentByCategory.get(categoryId) ?? 0;
      if (budget.amountCents <= 0) continue;
      const name = catName.get(categoryId) ?? "A category";
      if (spent > budget.amountCents) {
        insights.push({
          id: `budget-over-${categoryId}`,
          severity: "warning",
          title: `${name} is over budget`,
          detail: `${money(spent)} spent against a ${money(budget.amountCents)} budget — ${money(spent - budget.amountCents)} over with the month still running.`,
          page: "budgets",
          categoryId,
          accountId: null,
          amountCents: spent - budget.amountCents,
        });
      } else if (spent >= budget.amountCents * 0.9) {
        insights.push({
          id: `budget-near-${categoryId}`,
          severity: "info",
          title: `${name} is nearly spent`,
          detail: `${money(spent)} of ${money(budget.amountCents)} used — ${money(budget.amountCents - spent)} left this month.`,
          page: "budgets",
          categoryId,
          accountId: null,
          amountCents: budget.amountCents - spent,
        });
      }
    }

    // ── bills due but not funded ──
    const billRows = await app.db.select().from(bills).where(isNull(bills.archivedAt));
    const today = new Date();
    for (const bill of billRows) {
      // Shared with the bills endpoint so the two can't disagree about when a
      // bill lands — subtracting day-of-month numbers silently skips every bill
      // that falls early next month.
      const daysAway = daysUntilDue(bill.dueDay, today);
      if (daysAway > 7 || bill.autopay) continue;
      const short = bill.amountCents - bill.savedCents;
      if (short > 0) {
        insights.push({
          id: `bill-underfunded-${bill.id}`,
          severity: daysAway <= 3 ? "critical" : "warning",
          title: `${bill.name} is due in ${daysAway} day${daysAway === 1 ? "" : "s"}`,
          detail: `${money(bill.savedCents)} set aside of ${money(bill.amountCents)} — ${money(short)} short.`,
          page: "bills",
          categoryId: bill.categoryId,
          accountId: bill.accountId,
          amountCents: short,
        });
      }
    }

    // ── savings goals ──
    const goalRows = await app.db
      .select()
      .from(savingsGoals)
      .where(isNull(savingsGoals.archivedAt));
    for (const goal of goalRows) {
      const saved = goal.linkedAccountId
        ? (active.find((a) => a.id === goal.linkedAccountId)?.balanceCents ?? goal.savedCents)
        : goal.savedCents;
      if (saved >= goal.targetCents) {
        insights.push({
          id: `goal-funded-${goal.id}`,
          severity: "good",
          title: `${goal.name} is fully funded`,
          detail: `${money(saved)} saved against a ${money(goal.targetCents)} target. Worth redirecting that monthly contribution somewhere else.`,
          page: "goals",
          categoryId: null,
          accountId: goal.linkedAccountId,
          amountCents: saved,
        });
        continue;
      }
      if (goal.monthlyCents === 0) {
        insights.push({
          id: `goal-unfunded-${goal.id}`,
          severity: "info",
          title: `${goal.name} has no monthly plan`,
          detail: `It's ${money(goal.targetCents - saved)} short and nothing is routed to it each month, so it won't appear on your cash-flow diagram.`,
          page: "goals",
          categoryId: null,
          accountId: goal.linkedAccountId,
          amountCents: goal.targetCents - saved,
        });
      } else if (goal.targetDate) {
        const monthsLeft = Math.max(
          0,
          Math.ceil((Date.parse(`${goal.targetDate}T00:00:00Z`) - today.getTime()) / (30.44 * 86_400_000)),
        );
        const needed = monthsLeft > 0 ? Math.ceil((goal.targetCents - saved) / monthsLeft) : goal.targetCents - saved;
        if (needed > goal.monthlyCents) {
          insights.push({
            id: `goal-behind-${goal.id}`,
            severity: "warning",
            title: `${goal.name} won't make its date`,
            detail: `Contributing ${money(goal.monthlyCents)} a month, but hitting ${money(goal.targetCents)} by ${goal.targetDate} needs ${money(needed)}.`,
            page: "goals",
            categoryId: null,
            accountId: goal.linkedAccountId,
            amountCents: needed - goal.monthlyCents,
          });
        }
      }
    }

    // ── gift funds that won't be ready ──
    const givingRows = await app.db
      .select()
      .from(givingFunds)
      .where(isNull(givingFunds.archivedAt));
    for (const fund of givingRows) {
      if (fund.kind !== "gift" || !fund.targetCents || !fund.occasionDate) continue;
      const saved = fund.accountId
        ? (active.find((a) => a.id === fund.accountId)?.balanceCents ?? fund.savedCents)
        : fund.savedCents;
      const shortfall = fund.targetCents - saved;
      if (shortfall <= 0) continue;
      const monthsLeft = Math.max(
        1,
        Math.ceil((Date.parse(`${fund.occasionDate}T00:00:00Z`) - today.getTime()) / (30.44 * 86_400_000)),
      );
      const needed = Math.ceil(shortfall / monthsLeft);
      if (needed > fund.monthlyCents) {
        insights.push({
          id: `gift-behind-${fund.id}`,
          severity: "warning",
          title: `${fund.name} won't be ready in time`,
          detail: `${money(shortfall)} still to save before ${fund.occasionDate} — that's ${money(needed)} a month, not ${money(fund.monthlyCents)}.`,
          page: "giving",
          categoryId: fund.categoryId,
          accountId: fund.accountId,
          amountCents: needed - fund.monthlyCents,
        });
      }
    }

    // ── emergency-fund coverage ──
    // Three months of actual spending is the common floor. Measured against
    // real savings balances rather than a goal, because the money is what
    // matters, not whether it's been labelled.
    const savingsBalance = active
      .filter((a) => a.type === "savings" && !a.isLiability)
      .reduce((s, a) => s + a.balanceCents, 0);
    if (spendingCents > 0 && savingsBalance < spendingCents * 3) {
      insights.push({
        id: "emergency-fund-thin",
        severity: savingsBalance < spendingCents ? "warning" : "info",
        title: "Emergency fund is under three months",
        detail: `${money(savingsBalance)} in savings covers about ${(savingsBalance / spendingCents).toFixed(1)} months at this month's spending of ${money(spendingCents)}.`,
        page: "goals",
        categoryId: null,
        accountId: null,
        amountCents: spendingCents * 3 - savingsBalance,
      });
    }

    // ── uncategorized spending ──
    const [uncategorized] = await app.db
      .select({
        count: sql<string>`count(*)`,
        total: sql<string>`coalesce(sum(-${transactions.amountCents}), 0)`,
      })
      .from(transactions)
      .where(
        and(
          gte(transactions.postedAt, first),
          lt(transactions.postedAt, nextFirst),
          lt(transactions.amountCents, 0),
          isNull(transactions.categoryId),
          notArchived,
        ),
      );
    const uncategorizedCount = Number(uncategorized?.count ?? 0);
    if (uncategorizedCount >= 5) {
      insights.push({
        id: "uncategorized-spending",
        severity: "info",
        title: `${uncategorizedCount} transactions aren't categorized`,
        detail: `${money(Number(uncategorized?.total ?? 0))} of spending this month lands in "Uncategorized", which hides it from your budgets and diagram.`,
        page: "transactions",
        categoryId: null,
        accountId: null,
        amountCents: Number(uncategorized?.total ?? 0),
      });
    }

    // ── credit utilization ──
    for (const account of active) {
      if (account.type !== "credit_card" || account.balanceCents >= 0) continue;
      insights.push({
        id: `card-balance-${account.id}`,
        severity: "info",
        title: `${account.name} is carrying a balance`,
        detail: `${money(account.balanceCents)} outstanding. Paying it before the statement date avoids interest entirely.`,
        page: "accounts",
        categoryId: null,
        accountId: account.id,
        amountCents: Math.abs(account.balanceCents),
      });
    }

    insights.sort((a, b) => {
      const rank = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      return rank !== 0 ? rank : (b.amountCents ?? 0) - (a.amountCents ?? 0);
    });

    return {
      insights,
      criticalCount: insights.filter((i) => i.severity === "critical").length,
      warningCount: insights.filter((i) => i.severity === "warning").length,
    };
  });
}
