import type { MonthSummary, SankeyLink, SankeyNode, SankeyResponse, TrendsResponse } from "@vault/shared";
import { and, eq, gt, gte, isNull, lt, notInArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  accounts,
  bills,
  categories,
  debtPlan,
  givingFunds,
  savingsGoals,
  transactions,
} from "../../db/schema.js";

const SummaryQuery = z.object({
  months: z.coerce.number().int().min(1).max(24).default(6),
});
const SankeyQuery = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

function monthBounds(month: string): { first: string; nextFirst: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return { first: `${month}-01`, nextFirst: `${next}-01` };
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

// Income nodes are per-account; tint them from a rotating palette so different
// accounts read as distinct flows on the left of the diagram.
const ACCOUNT_INCOME_COLORS = ["#6f8ef2", "#8b7cf0", "#4db6d0", "#e0a458", "#c96f9c", "#5fbf8f"];
const DEBT_COLORS = ["#e25c5c", "#ec6a9c", "#e0a458", "#c96f9c", "#d8b23c"];
const SAVINGS_COLORS = ["#3ecf8e", "#43cfc0", "#4db6d0", "#5fbf8f", "#6f8ef2"];

/** Normalize a bill's per-occurrence amount to an equivalent monthly cost. */
function billMonthlyCents(amountCents: number, cadence: string): number {
  switch (cadence) {
    case "weekly":
      return Math.round((amountCents * 52) / 12);
    case "quarterly":
      return Math.round(amountCents / 3);
    case "yearly":
      return Math.round(amountCents / 12);
    default:
      return amountCents; // monthly
  }
}

/**
 * Estimated monthly minimum payment for a liability account. Mirrors the
 * client's DebtCalculator seed defaults so the Sankey's "Debt payments" branch
 * matches what the payoff planner shows for the same accounts.
 */
function debtMonthlyMin(type: string, balanceCents: number): number {
  const bal = Math.abs(balanceCents);
  if (type === "credit_card") return Math.max(2500, Math.round(bal * 0.02));
  if (type === "mortgage") return Math.max(50000, Math.round(bal * 0.005));
  return Math.max(5000, Math.round(bal * 0.01));
}

export default async function cashflowRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireAuth);

  app.get("/cashflow/summary", async (request) => {
    const { months } = SummaryQuery.parse(request.query);
    const current = new Date().toISOString().slice(0, 7);
    const start = shiftMonth(current, -(months - 1));
    const { first } = monthBounds(start);
    const { nextFirst } = monthBounds(current);

    const rows = await app.db
      .select({
        month: sql<string>`to_char(${transactions.postedAt}::date, 'YYYY-MM')`,
        income: sql<string>`coalesce(sum(${transactions.amountCents}) filter (where ${transactions.amountCents} > 0), 0)`,
        spending: sql<string>`coalesce(sum(-${transactions.amountCents}) filter (where ${transactions.amountCents} < 0), 0)`,
      })
      .from(transactions)
      .where(and(gte(transactions.postedAt, first), lt(transactions.postedAt, nextFirst)))
      .groupBy(sql`1`);
    const byMonth = new Map(rows.map((r) => [r.month, r]));

    const result: MonthSummary[] = [];
    for (let i = 0; i < months; i++) {
      const month = shiftMonth(start, i);
      const row = byMonth.get(month);
      const incomeCents = Number(row?.income ?? 0);
      const spendingCents = Number(row?.spending ?? 0);
      result.push({
        month,
        incomeCents,
        spendingCents,
        netCents: incomeCents - spendingCents,
        savingsRate:
          incomeCents > 0 ? Math.round(((incomeCents - spendingCents) / incomeCents) * 1000) / 1000 : null,
      });
    }
    return { months: result };
  });

  /**
   * Trend series for the dashboard charts: per-month income, spending, and an
   * estimated end-of-month net worth. Net worth is reconstructed backward from
   * the current account total: netWorth(end of month m) = currentTotal − (net
   * transaction flow in every month after m). The current month's point is just
   * the live total. Archived accounts and their transactions are excluded.
   */
  app.get("/cashflow/trends", async (request): Promise<TrendsResponse> => {
    const { months } = SummaryQuery.parse(request.query);
    const current = new Date().toISOString().slice(0, 7);
    const start = shiftMonth(current, -(months - 1));
    const { first } = monthBounds(start);
    const { nextFirst } = monthBounds(current);

    const accts = await app.db.select().from(accounts);
    const archivedIds = accts.filter((a) => a.archivedAt).map((a) => a.id);
    const notArchived = archivedIds.length
      ? notInArray(transactions.accountId, archivedIds)
      : undefined;
    const currentTotal = accts
      .filter((a) => !a.archivedAt)
      .reduce((s, a) => s + a.balanceCents, 0);

    const rows = await app.db
      .select({
        month: sql<string>`to_char(${transactions.postedAt}::date, 'YYYY-MM')`,
        income: sql<string>`coalesce(sum(${transactions.amountCents}) filter (where ${transactions.amountCents} > 0), 0)`,
        spending: sql<string>`coalesce(sum(-${transactions.amountCents}) filter (where ${transactions.amountCents} < 0), 0)`,
        net: sql<string>`coalesce(sum(${transactions.amountCents}), 0)`,
      })
      .from(transactions)
      .where(and(gte(transactions.postedAt, first), lt(transactions.postedAt, nextFirst), notArchived))
      .groupBy(sql`1`);
    const byMonth = new Map(rows.map((r) => [r.month, r]));

    const list: string[] = [];
    for (let i = 0; i < months; i++) list.push(shiftMonth(start, i));
    const netFlow = (m: string) => Number(byMonth.get(m)?.net ?? 0);

    const points = list.map((m, idx) => {
      let flowAfter = 0;
      for (let j = idx + 1; j < list.length; j++) flowAfter += netFlow(list[j]!);
      const row = byMonth.get(m);
      return {
        month: m,
        netWorthCents: currentTotal - flowAfter,
        incomeCents: Number(row?.income ?? 0),
        spendingCents: Number(row?.spending ?? 0),
      };
    });
    return { points };
  });

  /**
   * Multi-level Sankey aggregation. Income sources (depth 0, grouped by
   * category) flow into a total-income hub (depth 1). Spending then branches
   * down the category hierarchy (parentCategoryId): top-level categories at
   * depth 2, their subcategories at depth 3+. A category's flow is its own
   * direct spending plus everything spent in its descendants; when a category
   * has both children and direct spending, the direct part becomes a synthetic
   * leaf so flows stay balanced. Unspent income (income − spending) is not shown
   * — the diagram is a pure income → spending flow.
   */
  app.get("/cashflow/sankey", async (request): Promise<SankeyResponse> => {
    const query = SankeyQuery.parse(request.query);
    const month = query.month ?? new Date().toISOString().slice(0, 7);
    const { first, nextFirst } = monthBounds(month);

    // Archived accounts are excluded from the diagram entirely — their money is
    // no longer part of the active picture, so neither their income nor their
    // spending should appear.
    const accts = await app.db.select().from(accounts);
    const archivedIds = accts.filter((a) => a.archivedAt).map((a) => a.id);
    const notArchived = archivedIds.length
      ? notInArray(transactions.accountId, archivedIds)
      : undefined;

    // Spending grouped by category; income grouped by category too — its income
    // "source" (Salary, Side Income, Gifts…). Positive transactions without an
    // income source fall into an "Other income" bucket.
    const spendRows = await app.db
      .select({
        categoryId: transactions.categoryId,
        spending: sql<string>`coalesce(sum(-${transactions.amountCents}) filter (where ${transactions.amountCents} < 0), 0)`,
      })
      .from(transactions)
      .where(
        and(gte(transactions.postedAt, first), lt(transactions.postedAt, nextFirst), notArchived),
      )
      .groupBy(transactions.categoryId);

    const incomeRows = await app.db
      .select({
        categoryId: transactions.categoryId,
        income: sql<string>`coalesce(sum(${transactions.amountCents}), 0)`,
      })
      .from(transactions)
      .where(
        and(
          gte(transactions.postedAt, first),
          lt(transactions.postedAt, nextFirst),
          gt(transactions.amountCents, 0),
          notArchived,
        ),
      )
      .groupBy(transactions.categoryId);

    const cats = await app.db.select().from(categories);
    const catById = new Map(cats.map((c) => [c.id, c]));
    const childrenOf = new Map<string, string[]>();
    for (const c of cats) {
      if (c.parentCategoryId && catById.has(c.parentCategoryId)) {
        const arr = childrenOf.get(c.parentCategoryId) ?? [];
        arr.push(c.id);
        childrenOf.set(c.parentCategoryId, arr);
      }
    }

    // Build one income node per income source (income-kind category). Positive
    // transactions with no income source are summed into "Other income".
    const incomeBySource = new Map<string, number>();
    let otherIncome = 0;
    for (const row of incomeRows) {
      const value = Number(row.income);
      if (value <= 0) continue;
      const cat = row.categoryId ? catById.get(row.categoryId) : undefined;
      if (cat && cat.kind === "income") {
        incomeBySource.set(cat.id, (incomeBySource.get(cat.id) ?? 0) + value);
      } else {
        otherIncome += value;
      }
    }
    const incomeNodes: SankeyNode[] = [...incomeBySource.entries()].map(
      ([catId, value], i): SankeyNode => {
        const cat = catById.get(catId)!;
        return {
          id: `incat:${catId}`,
          label: cat.name,
          valueCents: value,
          color: cat.color ?? ACCOUNT_INCOME_COLORS[i % ACCOUNT_INCOME_COLORS.length]!,
          depth: 0,
          kind: "income",
          categoryId: catId,
          accountId: null,
          section: "income",
          entityId: null,
        };
      },
    );
    if (otherIncome > 0) {
      incomeNodes.push({
        id: "income:other",
        label: "Other income",
        valueCents: otherIncome,
        color: "#9aa0ab",
        depth: 0,
        kind: "income",
        categoryId: null,
        accountId: null,
        section: "income",
        entityId: null,
      });
    }

    const directSpend = new Map<string, number>();
    let uncategorizedSpend = 0;

    for (const row of spendRows) {
      const spending = Number(row.spending);
      const cat = row.categoryId ? catById.get(row.categoryId) : undefined;
      if (spending > 0) {
        if (cat) directSpend.set(cat.id, (directSpend.get(cat.id) ?? 0) + spending);
        else uncategorizedSpend += spending;
      }
    }
    incomeNodes.sort((a, b) => b.valueCents - a.valueCents);

    // Subtree total = direct spending + spending in all descendants (memoized).
    const subtreeTotal = new Map<string, number>();
    const computeSubtree = (id: string, seen: Set<string>): number => {
      if (subtreeTotal.has(id)) return subtreeTotal.get(id)!;
      if (seen.has(id)) return 0; // guard against cyclic parent links
      seen.add(id);
      let total = directSpend.get(id) ?? 0;
      for (const child of childrenOf.get(id) ?? []) total += computeSubtree(child, seen);
      subtreeTotal.set(id, total);
      return total;
    };
    for (const c of cats) computeSubtree(c.id, new Set());

    const nodes: SankeyNode[] = [...incomeNodes];
    const links: SankeyLink[] = [];

    // Walk the spending tree, emitting a node per category with spend and
    // linking parent → child. Depth 2 for top-level categories, +1 per level.
    const emitCategory = (id: string, depth: number): void => {
      const cat = catById.get(id);
      if (!cat) return;
      const total = subtreeTotal.get(id) ?? 0;
      nodes.push({
        id: `cat:${id}`,
        label: cat.name,
        valueCents: total,
        color: cat.color,
        depth,
        kind: "category",
        categoryId: id,
        section: "spending",
        entityId: id,
      });
      // Only show children with actual spend — empty ($0) categories are hidden
      // to keep the diagram readable. Income-kind categories never appear here.
      const children = (childrenOf.get(id) ?? []).filter(
        (cid) => catById.get(cid)?.kind !== "income" && (subtreeTotal.get(cid) ?? 0) > 0,
      );
      for (const child of children) {
        links.push({ from: `cat:${id}`, to: `cat:${child}`, valueCents: subtreeTotal.get(child) ?? 0 });
        emitCategory(child, depth + 1);
      }
      // Direct spending on a branch node becomes its own leaf so the parent's
      // inflow equals the sum of its outflows.
      const direct = directSpend.get(id) ?? 0;
      if (children.length > 0 && direct > 0) {
        nodes.push({
          id: `cat:${id}:direct`,
          label: `${cat.name} (direct)`,
          valueCents: direct,
          color: cat.color,
          depth: depth + 1,
          kind: "category",
          categoryId: id,
          section: "spending",
          entityId: id,
        });
        links.push({ from: `cat:${id}`, to: `cat:${id}:direct`, valueCents: direct });
      }
    };

    // Planned outflows: recurring bills + estimated debt minimums, each
    // normalized to a monthly figure. They're added as their own branches off
    // the hub alongside actual category spending (they may overlap it), and are
    // NOT counted in totalSpendingCents, which stays actual transaction spending.
    const billRows = await app.db.select().from(bills).where(isNull(bills.archivedAt));
    const billItems = billRows
      .map((b) => ({
        id: b.id,
        name: b.name,
        color: b.color,
        accountId: b.accountId,
        categoryId: b.categoryId,
        monthly: billMonthlyCents(b.amountCents, b.cadence),
      }))
      .filter((b) => b.monthly > 0)
      .sort((a, b) => b.monthly - a.monthly);
    const billsMonthlyTotal = billItems.reduce((s, b) => s + b.monthly, 0);

    // Debts mirror the payoff planner's persisted state: per-account overrides
    // (name/balance/APR/min) applied on top of liability accounts, plus any
    // manual debts the user added there. Falls back to estimates when unset.
    const plan = await app.db.query.debtPlan.findFirst({ where: eq(debtPlan.id, 1) });
    const overrides = plan?.overrides ?? {};
    const accountDebts = accts
      .filter((a) => !a.archivedAt && a.isLiability)
      .map((a) => {
        const o = overrides[a.id] ?? {};
        const balance = o.balanceCents ?? Math.abs(a.balanceCents);
        return {
          nodeId: `debtacct:${a.id}`,
          accountId: a.id as string | null,
          name: o.name ?? a.name,
          monthly: balance > 0 ? (o.minCents ?? debtMonthlyMin(a.type, balance)) : 0,
        };
      });
    const manualDebts = (plan?.manual ?? []).map((m) => ({
      nodeId: `debtmanual:${m.id}`,
      accountId: null as string | null,
      name: m.name,
      monthly: m.balanceCents > 0 ? m.minCents : 0,
    }));
    const debtItems = [...accountDebts, ...manualDebts]
      .filter((d) => d.monthly > 0)
      .sort((a, b) => b.monthly - a.monthly);
    const debtMonthlyTotal = debtItems.reduce((s, d) => s + d.monthly, 0);

    // Savings branch: one leaf per savings goal that has a planned monthly
    // contribution. A goal with no contribution set isn't a flow — it's a
    // balance — so it stays off the diagram until the user plans money into it.
    // Each leaf carries its linked accountId so drill-in shows the account the
    // money actually lands in.
    const goalRows = await app.db
      .select()
      .from(savingsGoals)
      .where(isNull(savingsGoals.archivedAt));
    const activeAccountIds = new Set(accts.filter((a) => !a.archivedAt).map((a) => a.id));
    const savingsItems = goalRows
      .map((g) => ({
        id: g.id,
        name: g.name,
        color: g.color,
        monthly: g.monthlyCents,
        // Drop a link to an archived account rather than pointing drill-in at
        // transactions the rest of the diagram deliberately excludes.
        accountId:
          g.linkedAccountId && activeAccountIds.has(g.linkedAccountId) ? g.linkedAccountId : null,
      }))
      .filter((g) => g.monthly > 0)
      .sort((a, b) => b.monthly - a.monthly);
    const savingsMonthlyTotal = savingsItems.reduce((s, g) => s + g.monthly, 0);

    // Giving splits into two branches off the hub because they answer different
    // questions: recurring giving is money gone for good, gift funds are money
    // parked until an occasion. Lumping them would hide the difference.
    const givingRows = await app.db
      .select()
      .from(givingFunds)
      .where(isNull(givingFunds.archivedAt));
    const givingItems = givingRows
      .map((f) => ({
        id: f.id,
        name: f.name,
        kind: f.kind,
        color: f.color,
        categoryId: f.categoryId,
        accountId: f.accountId && activeAccountIds.has(f.accountId) ? f.accountId : null,
        monthly: f.monthlyCents,
      }))
      .filter((f) => f.monthly > 0)
      .sort((a, b) => b.monthly - a.monthly);
    const givingRecurring = givingItems.filter((f) => f.kind === "giving");
    const givingGifts = givingItems.filter((f) => f.kind === "gift");
    const givingMonthlyTotal = givingRecurring.reduce((s, f) => s + f.monthly, 0);
    const giftsMonthlyTotal = givingGifts.reduce((s, f) => s + f.monthly, 0);

    const totalIncomeCents = incomeNodes.reduce((sum, n) => sum + n.valueCents, 0);
    let totalSpendingCents = uncategorizedSpend;
    // All top-level EXPENSE categories, including ones with no spending ($0).
    // Income sources live on the left of the diagram, not here.
    const topLevel = cats
      .filter((c) => !c.parentCategoryId && c.kind !== "income" && (subtreeTotal.get(c.id) ?? 0) > 0)
      .sort((a, b) => (subtreeTotal.get(b.id) ?? 0) - (subtreeTotal.get(a.id) ?? 0));

    if (
      totalIncomeCents > 0 ||
      totalSpendingCents > 0 ||
      topLevel.length > 0 ||
      billsMonthlyTotal > 0 ||
      debtMonthlyTotal > 0 ||
      savingsMonthlyTotal > 0 ||
      givingMonthlyTotal > 0 ||
      giftsMonthlyTotal > 0
    ) {
      nodes.push({
        id: "hub",
        label: "Total income",
        valueCents: totalIncomeCents,
        color: "#9397ab",
        depth: 1,
        kind: "hub",
        categoryId: null,
        section: "income",
        entityId: null,
      });
      for (const n of incomeNodes) links.push({ from: n.id, to: "hub", valueCents: n.valueCents });
    }

    for (const c of topLevel) {
      const total = subtreeTotal.get(c.id)!;
      totalSpendingCents += total;
      links.push({ from: "hub", to: `cat:${c.id}`, valueCents: total });
      emitCategory(c.id, 2);
    }
    if (uncategorizedSpend > 0) {
      nodes.push({
        id: "cat:none",
        label: "Uncategorized",
        valueCents: uncategorizedSpend,
        color: "#9aa0ab",
        depth: 2,
        kind: "category",
        categoryId: null,
        section: "spending",
        entityId: null,
      });
      links.push({ from: "hub", to: "cat:none", valueCents: uncategorizedSpend });
    }

    // Unspent income as its own node so the hub's inflow and outflow balance
    // exactly — the income-sources column and the "Total income" hub bar then
    // render the same height. Every planned outflow is carved out of income
    // first, so this node is what's genuinely left over and unassigned:
    // saved = income − spending − bills − debt − savings − giving − gifts.
    // Money going into a savings goal is NOT counted here — it has a job now,
    // and showing it twice would overstate what's actually free.
    const savedCents = Math.max(
      0,
      totalIncomeCents -
        totalSpendingCents -
        billsMonthlyTotal -
        debtMonthlyTotal -
        savingsMonthlyTotal -
        givingMonthlyTotal -
        giftsMonthlyTotal,
    );
    if (savedCents > 0) {
      nodes.push({
        id: "saved",
        label: "Unspent / saved",
        valueCents: savedCents,
        color: "#3ecf8e",
        depth: 2,
        kind: "saved",
        categoryId: null,
        section: "saved",
        entityId: null,
      });
      links.push({ from: "hub", to: "saved", valueCents: savedCents });
    }

    // Bills branch: hub → "Bills" → one leaf per bill (monthly-normalized).
    if (billsMonthlyTotal > 0) {
      nodes.push({
        id: "bills:hub",
        label: "Bills",
        valueCents: billsMonthlyTotal,
        color: "#6f8ef2",
        depth: 2,
        kind: "category",
        categoryId: null,
        section: "bills",
        entityId: null,
      });
      links.push({ from: "hub", to: "bills:hub", valueCents: billsMonthlyTotal });
      for (const b of billItems) {
        nodes.push({
          id: `bill:${b.id}`,
          label: b.name,
          valueCents: b.monthly,
          color: b.color,
          depth: 3,
          kind: "category",
          categoryId: b.categoryId,
          accountId: b.accountId ?? null,
          section: "bills",
          entityId: b.id,
          editableMonthlyCents: b.monthly,
        });
        links.push({ from: "bills:hub", to: `bill:${b.id}`, valueCents: b.monthly });
      }
    }

    // Debt branch: hub → "Debt payments" → one leaf per liability account, using
    // the same minimum-payment estimate as the payoff planner. Each leaf carries
    // its accountId so drill-in lists that account's transactions.
    if (debtMonthlyTotal > 0) {
      nodes.push({
        id: "debt:hub",
        label: "Debt payments",
        valueCents: debtMonthlyTotal,
        color: "#e25c5c",
        depth: 2,
        kind: "category",
        categoryId: null,
        section: "debt",
        entityId: null,
      });
      links.push({ from: "hub", to: "debt:hub", valueCents: debtMonthlyTotal });
      debtItems.forEach((d, i) => {
        nodes.push({
          id: d.nodeId,
          label: d.name,
          valueCents: d.monthly,
          color: DEBT_COLORS[i % DEBT_COLORS.length]!,
          depth: 3,
          kind: "category",
          categoryId: null,
          accountId: d.accountId,
          section: "debt",
          entityId: d.accountId,
          editableMonthlyCents: d.monthly,
        });
        links.push({ from: "debt:hub", to: d.nodeId, valueCents: d.monthly });
      });
    }

    // Savings branch: hub → "Savings" → one leaf per funded goal.
    if (savingsMonthlyTotal > 0) {
      nodes.push({
        id: "savings:hub",
        label: "Savings goals",
        valueCents: savingsMonthlyTotal,
        color: "#3ecf8e",
        depth: 2,
        kind: "category",
        categoryId: null,
        section: "savings",
        entityId: null,
      });
      links.push({ from: "hub", to: "savings:hub", valueCents: savingsMonthlyTotal });
      savingsItems.forEach((g, i) => {
        nodes.push({
          id: `goal:${g.id}`,
          label: g.name,
          valueCents: g.monthly,
          color: g.color || SAVINGS_COLORS[i % SAVINGS_COLORS.length]!,
          depth: 3,
          kind: "category",
          categoryId: null,
          accountId: g.accountId,
          section: "savings",
          entityId: g.id,
          editableMonthlyCents: g.monthly,
        });
        links.push({ from: "savings:hub", to: `goal:${g.id}`, valueCents: g.monthly });
      });
    }

    // Giving and gift branches, emitted separately (see above).
    const emitGivingBranch = (
      hubId: string,
      label: string,
      color: string,
      total: number,
      items: typeof givingItems,
    ): void => {
      if (total <= 0) return;
      nodes.push({
        id: hubId,
        label,
        valueCents: total,
        color,
        depth: 2,
        kind: "category",
        categoryId: null,
        section: "giving",
        entityId: null,
      });
      links.push({ from: "hub", to: hubId, valueCents: total });
      for (const f of items) {
        nodes.push({
          id: `giving:${f.id}`,
          label: f.name,
          valueCents: f.monthly,
          color: f.color,
          depth: 3,
          kind: "category",
          categoryId: f.categoryId,
          accountId: f.accountId,
          section: "giving",
          entityId: f.id,
          editableMonthlyCents: f.monthly,
        });
        links.push({ from: hubId, to: `giving:${f.id}`, valueCents: f.monthly });
      }
    };
    emitGivingBranch("giving:hub", "Giving", "#b47ef0", givingMonthlyTotal, givingRecurring);
    emitGivingBranch("gifts:hub", "Gift savings", "#ec6a9c", giftsMonthlyTotal, givingGifts);

    return { month, nodes, links, totalIncomeCents, totalSpendingCents };
  });
}
