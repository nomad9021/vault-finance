import type { MonthSummary, SankeyLink, SankeyNode, SankeyResponse } from "@vault/shared";
import { and, gte, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { categories, transactions } from "../../db/schema.js";

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

const SAVED_COLOR = "#3ecf8e";
const OTHER_INCOME_COLOR = "#6f8ef2";

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
   * Multi-level Sankey aggregation. Income sources (depth 0, grouped by
   * category) flow into a total-income hub (depth 1). Spending then branches
   * down the category hierarchy (parentCategoryId): top-level categories at
   * depth 2, their subcategories at depth 3+. A category's flow is its own
   * direct spending plus everything spent in its descendants; when a category
   * has both children and direct spending, the direct part becomes a synthetic
   * leaf so flows stay balanced. income − spending (when positive) is the
   * "Saved" leaf off the hub.
   */
  app.get("/cashflow/sankey", async (request): Promise<SankeyResponse> => {
    const query = SankeyQuery.parse(request.query);
    const month = query.month ?? new Date().toISOString().slice(0, 7);
    const { first, nextFirst } = monthBounds(month);

    const rows = await app.db
      .select({
        categoryId: transactions.categoryId,
        income: sql<string>`coalesce(sum(${transactions.amountCents}) filter (where ${transactions.amountCents} > 0), 0)`,
        spending: sql<string>`coalesce(sum(-${transactions.amountCents}) filter (where ${transactions.amountCents} < 0), 0)`,
      })
      .from(transactions)
      .where(and(gte(transactions.postedAt, first), lt(transactions.postedAt, nextFirst)))
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

    const directSpend = new Map<string, number>();
    let uncategorizedSpend = 0;
    const incomeNodes: SankeyNode[] = [];
    let otherIncome = 0;

    for (const row of rows) {
      const income = Number(row.income);
      const spending = Number(row.spending);
      const cat = row.categoryId ? catById.get(row.categoryId) : undefined;
      if (income > 0) {
        if (cat) {
          incomeNodes.push({
            id: `income:${cat.id}`,
            label: cat.name,
            valueCents: income,
            color: cat.color,
            depth: 0,
            kind: "income",
            categoryId: cat.id,
          });
        } else {
          otherIncome += income;
        }
      }
      if (spending > 0) {
        if (cat) directSpend.set(cat.id, (directSpend.get(cat.id) ?? 0) + spending);
        else uncategorizedSpend += spending;
      }
    }
    if (otherIncome > 0) {
      incomeNodes.push({
        id: "income:other",
        label: "Other income",
        valueCents: otherIncome,
        color: OTHER_INCOME_COLOR,
        depth: 0,
        kind: "income",
        categoryId: null,
      });
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
      const total = subtreeTotal.get(id) ?? 0;
      if (!cat || total <= 0) return;
      nodes.push({
        id: `cat:${id}`,
        label: cat.name,
        valueCents: total,
        color: cat.color,
        depth,
        kind: "category",
        categoryId: id,
      });
      const spendChildren = (childrenOf.get(id) ?? []).filter(
        (c) => (subtreeTotal.get(c) ?? 0) > 0,
      );
      for (const child of spendChildren) {
        links.push({ from: `cat:${id}`, to: `cat:${child}`, valueCents: subtreeTotal.get(child)! });
        emitCategory(child, depth + 1);
      }
      // Direct spending on a branch node becomes its own leaf so the parent's
      // inflow equals the sum of its outflows.
      const direct = directSpend.get(id) ?? 0;
      if (spendChildren.length > 0 && direct > 0) {
        nodes.push({
          id: `cat:${id}:direct`,
          label: `${cat.name} (direct)`,
          valueCents: direct,
          color: cat.color,
          depth: depth + 1,
          kind: "category",
          categoryId: id,
        });
        links.push({ from: `cat:${id}`, to: `cat:${id}:direct`, valueCents: direct });
      }
    };

    const totalIncomeCents = incomeNodes.reduce((sum, n) => sum + n.valueCents, 0);
    let totalSpendingCents = uncategorizedSpend;
    const topLevel = cats
      .filter((c) => !c.parentCategoryId && (subtreeTotal.get(c.id) ?? 0) > 0)
      .sort((a, b) => (subtreeTotal.get(b.id) ?? 0) - (subtreeTotal.get(a.id) ?? 0));

    if (totalIncomeCents > 0 || totalSpendingCents > 0 || topLevel.length > 0) {
      nodes.push({
        id: "hub",
        label: "Total income",
        valueCents: totalIncomeCents,
        color: "#9397ab",
        depth: 1,
        kind: "hub",
        categoryId: null,
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
      });
      links.push({ from: "hub", to: "cat:none", valueCents: uncategorizedSpend });
    }

    if (totalIncomeCents > totalSpendingCents) {
      const saved = totalIncomeCents - totalSpendingCents;
      nodes.push({
        id: "saved",
        label: "Saved",
        valueCents: saved,
        color: SAVED_COLOR,
        depth: 2,
        kind: "saved",
        categoryId: null,
      });
      links.push({ from: "hub", to: "saved", valueCents: saved });
    }

    return { month, nodes, links, totalIncomeCents, totalSpendingCents };
  });
}
