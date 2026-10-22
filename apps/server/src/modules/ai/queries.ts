import {
  estimateTaxes,
  findLocality,
  LOCALITIES_2026,
  STATES_2026,
  UNCATEGORIZED,
  type AiQuery,
  type Category,
  type PreIncome,
  type TaxEstimate,
  type TaxProfile,
} from "@vault/shared";
import { and, desc, eq, gte, isNull, lte, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { transactions } from "../../db/schema.js";
import { call, resolveCategory } from "./actions.js";

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

/** Start of a rolling window ending today: the last N days, or N months back from today. */
export function windowStart(q: { days?: number | undefined; months?: number | undefined }, defaultMonths = 3): string {
  const d = new Date();
  if (q.days) d.setUTCDate(d.getUTCDate() - q.days);
  else d.setUTCMonth(d.getUTCMonth() - (q.months ?? defaultMonths));
  return d.toISOString().slice(0, 10);
}

/** One status line for the app while look-ups run ("Checking your merchants…"). */
const QUERY_LABEL: Record<AiQuery["type"], string> = {
  transactions: "transactions",
  merchants: "merchants",
  category_totals: "category totals",
  budgets: "budgets",
  tax_estimate: "taxes",
  tax_whatif: "take-home what-if",
  tax_compare: "take-home in other states",
  tax_places: "local taxes",
  bills: "bills",
  subscriptions: "subscriptions",
  goals: "goals",
  buckets: "savings buckets",
  giving: "giving",
  debts: "debts",
  pre_income: "before-income items",
  cashflow: "cash flow",
  insights: "insights",
  accounts: "accounts",
};

export function describeQueries(queries: AiQuery[]): string {
  const parts = [...new Set(queries.map((q) => QUERY_LABEL[q.type]))];
  return parts.length ? `Checking your ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]}…` : "Looking things up…";
}

function describeEstimate(e: TaxEstimate, title: string): string[] {
  return [
    `${title} (${e.year}, ${e.stateName}${e.locality ? `, ${findLocality(e.locality)?.name}` : ""}):`,
    `  gross ${dollars(e.grossCents)} | pre-tax ${dollars(e.pretaxCents)} | taxes ${dollars(e.taxCents)} (${e.effectiveRatePct}% of gross) | take-home ${dollars(e.takeHomeCents)}/yr = ${dollars(Math.round(e.takeHomeCents / 12))}/mo`,
    `  next dollar: ${e.marginalFederalPct}% federal + ${e.marginalStatePct}% state/local + FICA`,
    ...e.lines.map((l) => `  ${l.label}: ${dollars(l.amountCents)}`),
    ...e.perEarner.map((p) => `  earner "${p.name}": gross ${dollars(p.grossCents)}, take-home ${dollars(p.takeHomeCents)}`),
    ...e.notes.map((n) => `  note: ${n}`),
  ];
}

export async function runQuery(app: FastifyInstance, request: FastifyRequest, q: AiQuery): Promise<string> {
  const get = <T>(url: string) => call<T>(app, request, "GET", url);
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
      if (q.days) filters.push(gte(transactions.postedAt, windowStart(q)));
      if (q.from) filters.push(gte(transactions.postedAt, q.from));
      if (q.to) filters.push(lte(transactions.postedAt, q.to));
      const limit = q.limit ?? 50;
      const where = filters.length ? and(...filters) : undefined;
      const rows = await app.db
        .select()
        .from(transactions)
        .where(where)
        .orderBy(desc(transactions.postedAt), desc(transactions.id))
        .limit(limit + 1);
      // Totals over every match, not just the rows shown, so the model never adds up itself.
      const [sum] = await app.db
        .select({
          count: sql<number>`count(*)::int`,
          out: sql<string>`coalesce(sum(-${transactions.amountCents}) filter (where ${transactions.amountCents} < 0), 0)`,
          inn: sql<string>`coalesce(sum(${transactions.amountCents}) filter (where ${transactions.amountCents} > 0), 0)`,
        })
        .from(transactions)
        .where(where);
      const lines = rows
        .slice(0, limit)
        .map((t) => `  ${t.postedAt} | ${t.merchantName.slice(0, 40)} | ${dollars(t.amountCents)} | ${pathOf(t.categoryId)}`);
      return [
        `TOTAL for these filters: ${sum?.count ?? 0} transactions, spent ${dollars(Number(sum?.out ?? 0))}, received ${dollars(Number(sum?.inn ?? 0))} (use these totals; don't add up yourself).`,
        `TRANSACTIONS (date | merchant | amount | category)${rows.length > limit ? `, newest ${limit} shown` : ""}:`,
        ...(lines.length ? lines : ["  (none match)"]),
      ].join("\n");
    }

    case "merchants": {
      const since = windowStart(q);
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
      const since = windowStart(q);
      const months = q.days ? q.days / 30.44 : (q.months ?? 3);
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
      return [`CATEGORY TOTALS from ${since} to today${q.days ? ` (last ${q.days} days)` : ` (last ${months} month${months > 1 ? "s" : ""})`}:`, ...(lines.length ? lines : ["  (no transactions)"])].join("\n");
    }

    case "budgets": {
      const month = new Date().toISOString().slice(0, 7);
      const { budgets } = await get<{ budgets: Array<{ categoryId: string; amountCents: number; spentCents?: number }> }>(`/budgets?month=${month}`);
      const plan = await get<{ plannedIncomeCents: number }>("/budget-plan");
      return [
        `BUDGETS ${month} (category | budget | spent): planned income ${dollars(plan.plannedIncomeCents)}/mo`,
        ...(budgets.length ? budgets.map((b) => `  ${pathOf(b.categoryId)} | ${dollars(b.amountCents)} | ${b.spentCents != null ? dollars(b.spentCents) : "?"}`) : ["  (no budgets)"]),
      ].join("\n");
    }

    case "tax_estimate":
    case "tax_whatif":
    case "tax_compare": {
      const { profile } = await get<{ profile: TaxProfile | null }>("/tax-profile");
      if (!profile || !profile.earners.length) {
        return "TAX: no tax profile is saved yet. If the user already gave a salary and where they live, propose set_tax_profile (state, locality) and set_salary now; otherwise ask for them.";
      }
      if (q.type === "tax_estimate") return describeEstimate(estimateTaxes(profile), "TAX ESTIMATE (saved profile)").join("\n");
      if (q.type === "tax_compare") {
        const rows = q.states.map((code) => {
          const st = code.toUpperCase();
          if (!(st in STATES_2026)) return `  ${code}: not a US state code`;
          const e = estimateTaxes({ ...profile, state: st, locality: null, customLocalRatePct: null, otherPayrollPct: null });
          return `  ${e.stateName}: take-home ${dollars(e.takeHomeCents)}/yr (${dollars(Math.round(e.takeHomeCents / 12))}/mo), taxes ${e.effectiveRatePct}% of gross`;
        });
        return [`TAKE-HOME BY STATE (same pay, no local tax; now: ${dollars(estimateTaxes(profile).takeHomeCents)}/yr in ${profile.state}):`, ...rows].join("\n");
      }
      const next: TaxProfile = { ...profile, earners: profile.earners.map((e) => ({ ...e })) };
      if (q.state) {
        next.state = q.state.toUpperCase();
        if (q.locality === undefined) next.locality = null;
      }
      if (q.locality !== undefined) next.locality = q.locality;
      if (q.filingStatus) next.filingStatus = q.filingStatus;
      if (q.dependents !== undefined) next.dependents = q.dependents;
      if (q.grossAnnual !== undefined || q.retirementPct !== undefined) {
        const e = q.earner ? next.earners.find((x) => x.name.toLowerCase() === q.earner!.toLowerCase()) : next.earners[0];
        if (!e) return `No earner called "${q.earner}". Earners: ${profile.earners.map((x) => x.name).join(", ")}.`;
        if (q.grossAnnual !== undefined) e.grossAnnualCents = Math.round(q.grossAnnual * 100);
        if (q.retirementPct !== undefined) {
          e.retirementPct = q.retirementPct;
          e.retirementCents = null;
        }
      }
      const before = estimateTaxes(profile);
      const after = estimateTaxes(next);
      const diff = after.takeHomeCents - before.takeHomeCents;
      return [
        ...describeEstimate(after, "TAX WHAT-IF (not saved)"),
        `  compared with now: take-home ${diff >= 0 ? "+" : "-"}${dollars(Math.abs(diff))}/yr (${diff >= 0 ? "+" : "-"}${dollars(Math.abs(Math.round(diff / 12)))}/mo)`,
      ].join("\n");
    }

    case "tax_places": {
      const code = q.state.toUpperCase();
      const st = (STATES_2026 as Record<string, { name: string; single: readonly unknown[] }>)[code];
      if (!st) return `${q.state} isn't a US state code.`;
      const locs = LOCALITIES_2026.filter((l) => l.state === code);
      return [
        `LOCAL TAXES IN ${st.name.toUpperCase()}${st.single.length ? "" : " (no state tax on wages)"}:`,
        ...(locs.length ? locs.map((l) => `  ${l.id}: ${l.name}${l.verified ? "" : " (rate not confirmed with the city)"}`) : ["  (none listed — use customLocalRatePct if their city has one)"]),
      ].join("\n");
    }

    case "bills": {
      const { bills } = await get<{ bills: Array<{ name: string; amountCents: number; cadence: string; dueDay: number; autopay: boolean; nextDueDate: string }> }>("/bills");
      return ["BILLS (name | amount | cadence | due):", ...(bills.length ? bills.map((b) => `  ${b.name} | ${dollars(b.amountCents)} | ${b.cadence} | day ${b.dueDay}, next ${b.nextDueDate}${b.autopay ? " | autopay" : ""}`) : ["  (none)"])].join("\n");
    }

    case "subscriptions": {
      const { subscriptions } = await get<{ subscriptions: Array<{ merchantName: string; amountCents: number; monthlyCents: number; cadence: string; occurrences: number; lastChargedAt: string }> }>("/subscriptions");
      return [
        "RECURRING CHARGES found in transactions (merchant | charge | per month | cadence | last):",
        ...(subscriptions.length ? subscriptions.slice(0, MAX_LINES).map((x) => `  ${x.merchantName} | ${dollars(x.amountCents)} | ${dollars(x.monthlyCents)}/mo | ${x.cadence} (${x.occurrences}×) | ${x.lastChargedAt}`) : ["  (none found)"]),
      ].join("\n");
    }

    case "goals": {
      const { goals } = await get<{ goals: Array<{ name: string; targetCents: number; savedCents: number; monthlyCents: number; targetDate: string | null }> }>("/goals");
      return ["SAVINGS GOALS (name | saved / target | per month | by):", ...(goals.length ? goals.map((g) => `  ${g.name} | ${dollars(g.savedCents)} / ${dollars(g.targetCents)} | ${dollars(g.monthlyCents)}/mo | ${g.targetDate ?? "no date"}`) : ["  (none)"])].join("\n");
    }

    case "buckets": {
      const { accounts } = await get<{ accounts: Array<{ accountName: string; balanceCents: number; unassignedCents: number; buckets: Array<{ name: string; allocatedCents: number; targetCents: number | null }> }> }>("/buckets");
      return [
        "SAVINGS BUCKETS (account: bucket = amount / target; Unassigned = balance not in a bucket):",
        ...accounts.map(
          (x) =>
            `  ${x.accountName} (balance ${dollars(x.balanceCents)}): ${[...x.buckets.map((b) => `${b.name} = ${dollars(b.allocatedCents)}${b.targetCents ? ` / ${dollars(b.targetCents)}` : ""}`), `Unassigned = ${dollars(x.unassignedCents)}`].join("; ")}`,
        ),
      ].join("\n");
    }

    case "giving": {
      const body = await get<{ funds: Array<{ name: string; kind: string; monthlyCents: number; savedCents: number; targetCents: number | null; occasionDate: string | null }>; givenThisYearCents: number }>("/giving");
      return [
        `GIVING FUNDS (given this year ${dollars(body.givenThisYearCents)}; name | kind | per month | saved / target | date):`,
        ...(body.funds.length ? body.funds.map((f) => `  ${f.name} | ${f.kind} | ${dollars(f.monthlyCents)}/mo | ${dollars(f.savedCents)}${f.targetCents ? ` / ${dollars(f.targetCents)}` : ""} | ${f.occasionDate ?? "-"}`) : ["  (none)"]),
      ].join("\n");
    }

    case "pre_income": {
      const pre = await get<PreIncome>("/pre-income");
      const { estimate } = await get<{ estimate: TaxEstimate | null }>("/tax-profile");
      return [
        `BEFORE INCOME on the Sankeys (name | kind | per month): ${pre.items.length} item(s) entered by the user;`,
        `  estimated taxes from the tax profile ${!estimate ? "(no tax profile)" : pre.useEstimate ? "are also shown" : "are turned off"}.`,
        ...(pre.items.length ? pre.items.map((i) => `  ${i.name} | ${i.kind} | ${dollars(i.monthlyCents)}`) : ["  (none)"]),
      ].join("\n");
    }

    case "debts": {
      const plan = await get<{ strategy: string; extraCents: number; manual: Array<{ name: string; balanceCents: number; apr: number; minCents: number }> }>("/debt-plan");
      const { accounts } = await get<{ accounts: Array<{ name: string; type: string; balanceCents: number; isLiability: boolean; interestRate: string | null }> }>("/accounts");
      const debts = accounts.filter((a) => a.isLiability);
      return [
        `DEBT PLAN: ${plan.strategy}, ${dollars(plan.extraCents)} extra a month.`,
        "DEBTS (name | balance | APR | minimum):",
        ...debts.map((d) => `  ${d.name} | ${dollars(d.balanceCents)} | ${d.interestRate ?? "?"}% | (from account)`),
        ...plan.manual.map((d) => `  ${d.name} | ${dollars(d.balanceCents)} | ${d.apr}% | ${dollars(d.minCents)}`),
        ...(debts.length || plan.manual.length ? [] : ["  (none)"]),
      ].join("\n");
    }

    case "cashflow": {
      const months = q.months ?? 6;
      const body = await get<{ months?: Array<{ month: string; incomeCents: number; spendingCents: number }>; points?: Array<{ month: string; incomeCents: number; spendingCents: number }> }>(`/cashflow/trends?months=${months}`);
      const rows = body.months ?? body.points ?? [];
      return ["CASH FLOW (month | income | spending | saved):", ...(rows.length ? rows.map((r) => `  ${r.month} | ${dollars(r.incomeCents)} | ${dollars(r.spendingCents)} | ${dollars(r.incomeCents - r.spendingCents)}`) : ["  (no data)"])].join("\n");
    }

    case "insights": {
      const { insights } = await get<{ insights: Array<{ title: string; detail?: string; severity?: string }> }>("/insights");
      return ["INSIGHTS:", ...(insights.length ? insights.slice(0, 30).map((i) => `  [${i.severity ?? "info"}] ${i.title}${i.detail ? ` — ${i.detail}` : ""}`) : ["  (nothing needs attention)"])].join("\n");
    }

    case "accounts": {
      const { accounts } = await get<{ accounts: Array<{ name: string; type: string; balanceCents: number; isLiability: boolean }> }>("/accounts");
      const net = accounts.reduce((s, a) => s + a.balanceCents, 0);
      return [`ACCOUNTS (net worth ${dollars(net)}; name | type | balance):`, ...accounts.map((a) => `  ${a.name} | ${a.type} | ${dollars(a.balanceCents)}`)].join("\n");
    }
  }
}

/** All of a reply's look-ups, answered as one message back to the model. */
export async function answerQueries(
  app: FastifyInstance,
  request: FastifyRequest,
  queries: AiQuery[],
  invalid: string[],
  stepsLeft: number,
  /** Look-ups already answered earlier in this message (JSON), so repeats get a nudge instead. */
  seen: Set<string> = new Set(),
): Promise<string> {
  const parts: string[] = [];
  for (const q of queries.slice(0, 4)) {
    const key = JSON.stringify(q);
    if (seen.has(key)) {
      parts.push(`You already have the results for ${key} above — use them.`);
      continue;
    }
    seen.add(key);
    try {
      parts.push(await runQuery(app, request, q));
    } catch (err) {
      parts.push(`Look-up ${JSON.stringify(q)} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (queries.length > 4) parts.push("(Only the first 4 look-ups were run.)");
  for (const raw of invalid.slice(0, 3)) parts.push(`Couldn't read this look-up (check the type and fields): ${raw.slice(0, 200)}`);
  parts.push(
    stepsLeft > 0
      ? `Continue your answer to the user now. If you have what you need, propose the changes (<vault-action> blocks) instead of looking up more. You can look things up ${stepsLeft} more time${stepsLeft > 1 ? "s" : ""}.`
      : "Finish your answer to the user now, without more look-ups: propose the changes (<vault-action> blocks) that the request needs.",
  );
  return ["=== LOOK-UP RESULTS (from the household's data) ===", ...parts].join("\n\n");
}
