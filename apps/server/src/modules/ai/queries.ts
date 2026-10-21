import { UNCATEGORIZED, type AiQuery, type Category } from "@vault/shared";
import { and, desc, eq, gte, isNull, lte, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { transactions } from "../../db/schema.js";
import { resolveCategory } from "./actions.js";

/**
 * Answers the assistant's <vault-query> look-ups (the agent loop in
 * routes.ts). Read-only, and every answer is capped so a small local model's
 * context isn't swamped: the model can always narrow the next look-up.
 */

const MAX_LINES = 100;

function dollars(cents: number): string {
  const abs = (Math.abs(cents) / 100).toFixed(2);
  return `${cents < 0 ? "-" : ""}$${abs}`;
}

function monthsAgo(months: number): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - (months - 1));
  return d.toISOString().slice(0, 10);
}

/** One status line for the app while look-ups run ("Checking your merchants…"). */
export function describeQueries(queries: AiQuery[]): string {
  const kinds = new Set(queries.map((q) => q.type));
  const parts = [
    kinds.has("transactions") && "transactions",
    kinds.has("merchants") && "merchants",
    kinds.has("category_totals") && "category totals",
  ].filter(Boolean);
  return parts.length ? `Checking your ${parts.join(" and ")}…` : "Looking things up…";
}

export async function runQuery(app: FastifyInstance, q: AiQuery): Promise<string> {
  // Same fields resolveCategory reads (name, parentCategoryId, id).
  const allCats = (await app.db.query.categories.findMany()) as unknown as Category[];
  const byId = new Map(allCats.map((c) => [c.id, c]));
  const pathOf = (id: string | null): string => {
    if (!id) return UNCATEGORIZED;
    const out: string[] = [];
    for (let c = byId.get(id), n = 0; c && n < 10; c = c.parentCategoryId ? byId.get(c.parentCategoryId) : undefined, n++) {
      out.unshift(c.name);
    }
    return out.join(" > ") || "?";
  };

  switch (q.type) {
    case "transactions": {
      const filters: SQL[] = [];
      if (q.merchant) {
        filters.push(sql`${transactions.merchantName} ilike ${`%${q.merchant.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}`);
      }
      if (q.category) {
        if (q.category.trim().toLowerCase() === UNCATEGORIZED.toLowerCase()) filters.push(isNull(transactions.categoryId));
        else filters.push(eq(transactions.categoryId, resolveCategory(allCats, q.category).id));
      }
      if (q.from) filters.push(gte(transactions.postedAt, q.from));
      if (q.to) filters.push(lte(transactions.postedAt, q.to));
      const limit = q.limit ?? 50;
      const rows = await app.db
        .select()
        .from(transactions)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(transactions.postedAt), desc(transactions.id))
        .limit(limit + 1);
      const lines = rows
        .slice(0, limit)
        .map((t) => `  ${t.postedAt} | ${t.merchantName.slice(0, 40)} | ${dollars(t.amountCents)} | ${pathOf(t.categoryId)}`);
      return [
        `TRANSACTIONS (date | merchant | amount | category)${rows.length > limit ? `, newest ${limit} shown` : ""}:`,
        ...(lines.length ? lines : ["  (none match)"]),
      ].join("\n");
    }

    case "merchants": {
      const since = monthsAgo(q.months ?? 3);
      const rows = await app.db
        .select({
          merchant: sql<string>`min(${transactions.merchantName})`,
          count: sql<number>`count(*)::int`,
          out: sql<string>`coalesce(sum(-${transactions.amountCents}) filter (where ${transactions.amountCents} < 0), 0)`,
          inn: sql<string>`coalesce(sum(${transactions.amountCents}) filter (where ${transactions.amountCents} > 0), 0)`,
          // A plain string ("" = uncategorized): the driver doesn't decode arrays.
          categoryIds: sql<string>`string_agg(distinct coalesce(${transactions.categoryId}::text, ''), ',')`,
        })
        .from(transactions)
        .where(and(gte(transactions.postedAt, since), q.uncategorizedOnly ? isNull(transactions.categoryId) : undefined))
        .groupBy(sql`lower(${transactions.merchantName})`)
        .orderBy(sql`count(*) desc`)
        .limit(MAX_LINES);
      const lines = rows.map((r) => {
        const total = Number(r.inn) > Number(r.out) ? `in ${dollars(Number(r.inn))}` : `out ${dollars(Number(r.out))}`;
        const cats = (r.categoryIds ?? "").split(",").map((id) => pathOf(id || null)).join(", ");
        return `  ${r.merchant.slice(0, 40)} | ${r.count}× | ${total} | ${cats}`;
      });
      return [
        `MERCHANTS since ${since}${q.uncategorizedOnly ? ", uncategorized only" : ""} (merchant | count | total | categories used), busiest first:`,
        ...(lines.length ? lines : ["  (none)"]),
      ].join("\n");
    }

    case "category_totals": {
      const months = q.months ?? 3;
      const since = monthsAgo(months);
      const rows = await app.db
        .select({
          categoryId: transactions.categoryId,
          count: sql<number>`count(*)::int`,
          out: sql<string>`coalesce(sum(-${transactions.amountCents}) filter (where ${transactions.amountCents} < 0), 0)`,
          inn: sql<string>`coalesce(sum(${transactions.amountCents}) filter (where ${transactions.amountCents} > 0), 0)`,
        })
        .from(transactions)
        .where(gte(transactions.postedAt, since))
        .groupBy(transactions.categoryId);
      const lines = rows
        .sort((a, b) => Number(b.out) + Number(b.inn) - (Number(a.out) + Number(a.inn)))
        .slice(0, MAX_LINES)
        .map((r) => {
          const out = Number(r.out), inn = Number(r.inn);
          return `  ${pathOf(r.categoryId)} | ${r.count} txns | spent ${dollars(out)} (${dollars(Math.round(out / months))}/mo)${inn ? ` | income ${dollars(inn)}` : ""}`;
        });
      return [`CATEGORY TOTALS since ${since} (${months} month${months > 1 ? "s" : ""}):`, ...(lines.length ? lines : ["  (no transactions)"])].join("\n");
    }
  }
}

/** All of a reply's look-ups, answered as one message back to the model. */
export async function answerQueries(
  app: FastifyInstance,
  queries: AiQuery[],
  invalid: string[],
  stepsLeft: number,
): Promise<string> {
  const parts: string[] = [];
  for (const q of queries.slice(0, 4)) {
    try {
      parts.push(await runQuery(app, q));
    } catch (err) {
      parts.push(`Look-up ${JSON.stringify(q)} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (queries.length > 4) parts.push("(Only the first 4 look-ups were run.)");
  for (const raw of invalid.slice(0, 3)) parts.push(`Couldn't read this look-up (check the type and fields): ${raw.slice(0, 200)}`);
  parts.push(
    stepsLeft > 0
      ? `Continue your answer to the user now. You can look things up ${stepsLeft} more time${stepsLeft > 1 ? "s" : ""}.`
      : "Finish your answer to the user now, without more look-ups.",
  );
  return ["=== LOOK-UP RESULTS (from the household's data) ===", ...parts].join("\n\n");
}
