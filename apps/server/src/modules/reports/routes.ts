import {
  ReviewQuery,
  type CategorySpend,
  type MonthlyReport,
  type MonthSummary,
  type PeriodReview,
  type ReviewPeriod,
} from "@vault/shared";
import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  accounts,
  categories,
  monthlyReportSnapshots,
  transactions,
} from "../../db/schema.js";
import type { AppConfig } from "../../config.js";
import { configForFeature } from "../ai/model-manager.js";
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

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
}

/**
 * [start, end) for a review period plus the same-length period before it.
 * Months snap to the 1st; weeks are 7 days from `start` (the client picks
 * Sunday or Monday), defaulting to this week's Monday.
 */
export function reviewBounds(
  period: ReviewPeriod,
  start: string | undefined,
  today: Date = new Date(),
): { start: string; end: string; prevStart: string } {
  if (period === "month") {
    const month = (start ?? isoDay(today)).slice(0, 7);
    const { first, nextFirst } = monthBounds(month);
    const [y, m] = month.split("-").map(Number) as [number, number];
    const prevStart = isoDay(new Date(Date.UTC(y, m - 2, 1)));
    return { start: first, end: nextFirst, prevStart };
  }
  let first = start;
  if (!first) {
    const sinceMonday = (today.getUTCDay() + 6) % 7;
    first = addDays(isoDay(today), -sinceMonday);
  }
  return { start: first, end: addDays(first, 7), prevStart: addDays(first, -7) };
}

function csvEscape(value: string): string {
  // Spreadsheet formula-injection defense (OWASP): a field beginning with
  // = + - @ or a control char is interpreted as a formula by Excel/Sheets.
  // Prefix a single quote so the cell renders as literal text. Do this before
  // quoting so the guard character lands inside the quotes.
  let v = value;
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
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
          configForFeature(settings, "reports"),
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

  async function rangeTotals(from: string, to: string) {
    const [row] = await app.db
      .select({
        income: sql<string>`coalesce(sum(${transactions.amountCents}) filter (where ${transactions.amountCents} > 0), 0)`,
        spending: sql<string>`coalesce(sum(-${transactions.amountCents}) filter (where ${transactions.amountCents} < 0), 0)`,
        count: sql<string>`count(*)`,
      })
      .from(transactions)
      .where(and(gte(transactions.postedAt, from), lt(transactions.postedAt, to)));
    const incomeCents = Number(row?.income ?? 0);
    const spendingCents = Number(row?.spending ?? 0);
    return {
      incomeCents,
      spendingCents,
      savedCents: incomeCents - spendingCents,
      transactionCount: Number(row?.count ?? 0),
    };
  }

  async function spendByCategory(from: string, to: string) {
    const rows = await app.db
      .select({
        categoryId: transactions.categoryId,
        spent: sql<string>`coalesce(sum(-${transactions.amountCents}) filter (where ${transactions.amountCents} < 0), 0)`,
      })
      .from(transactions)
      .where(and(gte(transactions.postedAt, from), lt(transactions.postedAt, to)))
      .groupBy(transactions.categoryId);
    return new Map(rows.map((r) => [r.categoryId, Number(r.spent)]));
  }

  /** Weekly / monthly review — everything the presenter slideshow shows. */
  app.get("/reports/review", async (request): Promise<PeriodReview> => {
    const query = ReviewQuery.parse(request.query);
    const { start, end, prevStart } = reviewBounds(query.period, query.start);
    const inPeriod = and(gte(transactions.postedAt, start), lt(transactions.postedAt, end));

    const totals = await rangeTotals(start, end);
    const previous = await rangeTotals(prevStart, start);

    const cats = await app.db.select().from(categories);
    const byId = new Map(cats.map((c) => [c.id, c]));
    const catName = (id: string | null) =>
      id ? (byId.get(id)?.name ?? "Unknown") : "Uncategorized";
    const catColor = (id: string | null) => (id ? (byId.get(id)?.color ?? "#9aa0ab") : "#9aa0ab");

    const now = await spendByCategory(start, end);
    const before = await spendByCategory(prevStart, start);
    const categoryRows = [...now]
      .filter(([, spent]) => spent > 0)
      .map(([categoryId, spentCents]) => ({
        categoryId,
        name: catName(categoryId),
        color: catColor(categoryId),
        spentCents,
        previousSpentCents: before.get(categoryId) ?? 0,
      }))
      .sort((a, b) => b.spentCents - a.spentCents);

    const merchants = await app.db
      .select({
        name: transactions.merchantName,
        spent: sql<string>`sum(-${transactions.amountCents})`,
        count: sql<string>`count(*)`,
      })
      .from(transactions)
      .where(and(inPeriod, lt(transactions.amountCents, 0)))
      .groupBy(transactions.merchantName)
      .orderBy(desc(sql`sum(-${transactions.amountCents})`))
      .limit(5);

    const largest = await app.db
      .select({
        id: transactions.id,
        postedAt: transactions.postedAt,
        merchantName: transactions.merchantName,
        amountCents: transactions.amountCents,
        categoryId: transactions.categoryId,
      })
      .from(transactions)
      .where(and(inPeriod, lt(transactions.amountCents, 0)))
      .orderBy(asc(transactions.amountCents))
      .limit(5);

    const daily = await app.db
      .select({
        date: transactions.postedAt,
        spent: sql<string>`sum(-${transactions.amountCents})`,
      })
      .from(transactions)
      .where(and(inPeriod, lt(transactions.amountCents, 0)))
      .groupBy(transactions.postedAt);
    const dailyByDate = new Map(daily.map((d) => [String(d.date), Number(d.spent)]));
    const dailySpending: PeriodReview["dailySpending"] = [];
    for (let day = start; day < end; day = addDays(day, 1)) {
      dailySpending.push({ date: day, spentCents: dailyByDate.get(day) ?? 0 });
    }

    return {
      period: query.period,
      start,
      end,
      ...totals,
      savingsRate:
        totals.incomeCents > 0
          ? Math.round((totals.savedCents / totals.incomeCents) * 1000) / 1000
          : null,
      previous,
      categories: categoryRows,
      topMerchants: merchants.map((m) => ({
        name: m.name,
        spentCents: Number(m.spent),
        count: Number(m.count),
      })),
      largestPurchases: largest.map((t) => ({
        id: t.id,
        postedAt: String(t.postedAt),
        merchantName: t.merchantName,
        amountCents: t.amountCents,
        categoryName: catName(t.categoryId),
        color: catColor(t.categoryId),
      })),
      dailySpending,
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
