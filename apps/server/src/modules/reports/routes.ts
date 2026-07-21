import type { CategorySpend, MonthlyReport, MonthSummary } from "@vault/shared";
import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  accounts,
  categories,
  monthlyReportSnapshots,
  transactions,
} from "../../db/schema.js";
import type { AppConfig } from "../../config.js";
import { AI_FEATURE_QUALITY } from "@vault/shared";
import { configForQuality } from "../ai/model-manager.js";
import { getProvider, isConfigured } from "../ai/providers/index.js";
import { resolveSettings } from "../ai/settings.js";

const MonthlyQuery = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});
const YearlyQuery = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});
const ExportQuery = z.object({
  type: z.literal("transactions"),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

function monthBounds(month: string): { first: string; nextFirst: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return { first: `${month}-01`, nextFirst: `${next}-01` };
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export default async function reportRoutes(
  app: FastifyInstance,
  opts: { config: AppConfig },
) {
  app.addHook("preHandler", app.requireAuth);

  async function monthTotals(month: string) {
    const { first, nextFirst } = monthBounds(month);
    const [row] = await app.db
      .select({
        income: sql<string>`coalesce(sum(${transactions.amountCents}) filter (where ${transactions.amountCents} > 0), 0)`,
        spending: sql<string>`coalesce(sum(-${transactions.amountCents}) filter (where ${transactions.amountCents} < 0), 0)`,
      })
      .from(transactions)
      .where(and(gte(transactions.postedAt, first), lt(transactions.postedAt, nextFirst)));
    const incomeCents = Number(row?.income ?? 0);
    const spendingCents = Number(row?.spending ?? 0);
    return { incomeCents, spendingCents, savedCents: incomeCents - spendingCents };
  }

  async function topCategories(month: string): Promise<CategorySpend[]> {
    const { first, nextFirst } = monthBounds(month);
    const rows = await app.db
      .select({
        categoryId: transactions.categoryId,
        spent: sql<string>`coalesce(sum(-${transactions.amountCents}) filter (where ${transactions.amountCents} < 0), 0)`,
      })
      .from(transactions)
      .where(and(gte(transactions.postedAt, first), lt(transactions.postedAt, nextFirst)))
      .groupBy(transactions.categoryId);
    const cats = await app.db.select().from(categories);
    const byId = new Map(cats.map((c) => [c.id, c]));
    return rows
      .map((r) => ({
        categoryId: r.categoryId,
        name: r.categoryId ? (byId.get(r.categoryId)?.name ?? "Unknown") : "Uncategorized",
        color: r.categoryId ? (byId.get(r.categoryId)?.color ?? "#9aa0ab") : "#9aa0ab",
        spentCents: Number(r.spent),
      }))
      .filter((r) => r.spentCents > 0)
      .sort((a, b) => b.spentCents - a.spentCents)
      .slice(0, 6);
  }

  /**
   * AI commentary for CLOSED months only, cached in monthly_report_snapshots.
   * The cache also stores the totals it was generated from — if the user
   * later edits that month's history, the summary regenerates. Reports stay
   * fully functional with aiSummary null when Ollama is off (roadmap M4/M5
   * graceful-degradation requirement).
   */
  async function aiSummaryFor(
    month: string,
    totals: { incomeCents: number; spendingCents: number; savedCents: number },
    top: CategorySpend[],
  ): Promise<string | null> {
    const currentMonth = new Date().toISOString().slice(0, 7);
    if (month >= currentMonth) return null; // open month — numbers still moving

    const monthDate = `${month}-01`;
    const cached = await app.db.query.monthlyReportSnapshots.findFirst({
      where: eq(monthlyReportSnapshots.month, monthDate),
    });
    if (
      cached?.aiSummary &&
      cached.incomeCents === totals.incomeCents &&
      cached.spendingCents === totals.spendingCents
    ) {
      return cached.aiSummary;
    }

    const settings = await resolveSettings(app, opts.config);
    if (!settings.enabled || !isConfigured(settings.aiConfig)) return null;

    const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
    const prompt = [
      `Write a 3-4 sentence plain-text summary of this household's ${month} finances.`,
      "Be specific with the numbers given, lead with the bottom line, no greetings, no markdown.",
      `Income: ${dollars(totals.incomeCents)}. Spending: ${dollars(totals.spendingCents)}. Saved: ${dollars(totals.savedCents)}.`,
      `Top spending: ${top.map((t) => `${t.name} ${dollars(t.spentCents)}`).join(", ") || "none"}.`,
    ].join("\n");

    let summary: string;
    try {
      summary = (
        await getProvider(settings.provider).generateText(
          configForQuality(settings, AI_FEATURE_QUALITY.reports),
          prompt,
        )
      ).trim();
    } catch {
      return cached?.aiSummary ?? null; // stale beats nothing; null beats neither
    }

    await app.db
      .insert(monthlyReportSnapshots)
      .values({ month: monthDate, ...totals, aiSummary: summary })
      .onConflictDoUpdate({
        target: monthlyReportSnapshots.month,
        set: { ...totals, aiSummary: summary, generatedAt: new Date() },
      });
    return summary;
  }

  app.get("/reports/monthly", async (request): Promise<MonthlyReport> => {
    const query = MonthlyQuery.parse(request.query);
    const month = query.month ?? new Date().toISOString().slice(0, 7);
    const totals = await monthTotals(month);
    const top = await topCategories(month);
    return {
      month,
      ...totals,
      savingsRate:
        totals.incomeCents > 0
          ? Math.round((totals.savedCents / totals.incomeCents) * 1000) / 1000
          : null,
      topCategories: top,
      aiSummary: await aiSummaryFor(month, totals, top),
    };
  });

  app.get("/reports/yearly", async (request) => {
    const query = YearlyQuery.parse(request.query);
    const year = query.year ?? new Date().getUTCFullYear();

    const months: MonthSummary[] = [];
    for (let m = 1; m <= 12; m++) {
      const month = `${year}-${String(m).padStart(2, "0")}`;
      const totals = await monthTotals(month);
      months.push({
        month,
        incomeCents: totals.incomeCents,
        spendingCents: totals.spendingCents,
        netCents: totals.savedCents,
        savingsRate:
          totals.incomeCents > 0
            ? Math.round((totals.savedCents / totals.incomeCents) * 1000) / 1000
            : null,
      });
    }
    const totalIncomeCents = months.reduce((s, m) => s + m.incomeCents, 0);
    const totalSpendingCents = months.reduce((s, m) => s + m.spendingCents, 0);
    return {
      year,
      months,
      totalIncomeCents,
      totalSpendingCents,
      totalSavedCents: totalIncomeCents - totalSpendingCents,
      savingsRate:
        totalIncomeCents > 0
          ? Math.round(((totalIncomeCents - totalSpendingCents) / totalIncomeCents) * 1000) / 1000
          : null,
    };
  });

  /** CSV export, generated on request — never written to disk (privacy spec). */
  app.get("/export/csv", async (request, reply) => {
    const query = ExportQuery.parse(request.query);
    const filters = [
      ...(query.from ? [gte(transactions.postedAt, query.from)] : []),
      ...(query.to ? [lt(transactions.postedAt, query.to)] : []),
    ];
    const rows = await app.db
      .select({
        postedAt: transactions.postedAt,
        merchantName: transactions.merchantName,
        amountCents: transactions.amountCents,
        categoryId: transactions.categoryId,
        accountId: transactions.accountId,
        description: transactions.description,
      })
      .from(transactions)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(asc(transactions.postedAt));

    const cats = new Map(
      (await app.db.select().from(categories)).map((c) => [c.id, c.name]),
    );
    const accs = new Map((await app.db.select().from(accounts)).map((a) => [a.id, a.name]));

    const lines = ["date,merchant,amount,category,account,description"];
    for (const r of rows) {
      lines.push(
        [
          r.postedAt,
          csvEscape(r.merchantName),
          (r.amountCents / 100).toFixed(2),
          csvEscape(r.categoryId ? (cats.get(r.categoryId) ?? "") : ""),
          csvEscape(accs.get(r.accountId) ?? ""),
          csvEscape(r.description ?? ""),
        ].join(","),
      );
    }
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", 'attachment; filename="vault-transactions.csv"')
      .send(lines.join("\n") + "\n");
  });
}
