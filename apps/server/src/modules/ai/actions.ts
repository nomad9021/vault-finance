import { randomUUID } from "node:crypto";
import {
  CLIENT_ACTION_TYPES,
  describeAiAction,
  UNCATEGORIZED,
  findLocality,
  LOCALITIES_2026,
  STATES_2026,
  type PreIncome,
  type TaxProfile,
  type AiAction,
  type AiActionRecord,
  type Category,
} from "@vault/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { aiActions } from "../../db/schema.js";
import { AGENTS, STYLE_AND_LIMITS, type AgentId } from "./agents.js";

/**
 * Carrying out what the assistant proposes. Every server-side change goes
 * through the app's own REST routes via `app.inject`, signed in as the user
 * who approved it — so validation, owner-only checks and side effects are
 * exactly what the Settings screens get, with no second code path to drift.
 */

type Row = typeof aiActions.$inferSelect;

export function toRecord(row: Row): AiActionRecord {
  const action = JSON.parse(row.action) as AiAction;
  return {
    id: row.id,
    conversationId: row.conversationId,
    messageId: row.messageId,
    action,
    summary: row.summary,
    client: CLIENT_ACTION_TYPES.has(action.type),
    status: row.status,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function recordActions(
  app: FastifyInstance,
  opts: { conversationId: string; messageId: string; userId: string },
  actions: AiAction[],
): Promise<Row[]> {
  if (actions.length === 0) return [];
  return app.db
    .insert(aiActions)
    .values(
      actions.map((a) => ({
        conversationId: opts.conversationId,
        messageId: opts.messageId,
        userId: opts.userId,
        action: JSON.stringify(a),
        summary: describeAiAction(a),
      })),
    )
    .returning();
}

/** Apply one stored action and record the outcome. Never throws for a failed change. */
export async function applyStoredAction(
  app: FastifyInstance,
  request: FastifyRequest,
  row: Row,
): Promise<Row> {
  const action = JSON.parse(row.action) as AiAction;
  let status: Row["status"] = "applied";
  let error: string | null = null;
  try {
    await applyAction(app, request, action);
  } catch (err) {
    status = "failed";
    error = err instanceof Error ? err.message : String(err);
  }
  const [updated] = await app.db
    .update(aiActions)
    .set({ status, error, decidedAt: new Date() })
    .where(eq(aiActions.id, row.id))
    .returning();
  return updated!;
}

class ActionError extends Error {}

export async function call<T = unknown>(
  app: FastifyInstance,
  request: FastifyRequest,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  payload?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {};
  const auth = request.headers.authorization;
  if (auth) headers.authorization = auth;
  const version = request.headers["x-client-version"];
  if (typeof version === "string") headers["x-client-version"] = version;
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
  if (res.statusCode >= 400) {
    let message = `The server refused the change (HTTP ${res.statusCode}).`;
    try {
      const body = res.json() as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      // keep the generic message
    }
    throw new ActionError(message);
  }
  return (res.statusCode === 204 ? undefined : res.json()) as T;
}

/** Category by name, or "Parent > Child" path; case-insensitive. */
export function resolveCategory(all: Category[], ref: string): Category {
  const parts = ref.split(">").map((p) => p.trim().toLowerCase()).filter(Boolean);
  const name = parts[parts.length - 1] ?? "";
  const byId = new Map(all.map((c) => [c.id, c]));
  const pathOf = (c: Category): string[] => {
    const out: string[] = [];
    for (let cur: Category | undefined = c; cur; cur = cur.parentCategoryId ? byId.get(cur.parentCategoryId) : undefined) {
      out.unshift(cur.name.toLowerCase());
      if (out.length > 20) break; // cycle guard
    }
    return out;
  };
  const matches = all.filter((c) => {
    if (c.name.toLowerCase() !== name) return false;
    if (parts.length === 1) return true;
    const p = pathOf(c);
    return parts.every((part, i) => p[p.length - parts.length + i] === part);
  });
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new ActionError(`There's no category called "${ref}".`);
  throw new ActionError(
    `Several categories are called "${ref}" — say which, like "${pathOf(matches[0]!).join(" > ")}".`,
  );
}

const DEFAULT_COLOR = "#6b7bd6";

/** A bill, goal, giving fund or earner by name (case-insensitive). */
function resolveNamed<T extends { name: string }>(list: T[], ref: string, what: string): T {
  const matches = list.filter((x) => x.name.trim().toLowerCase() === ref.trim().toLowerCase());
  if (matches.length === 1) return matches[0]!;
  if (!matches.length) throw new ActionError(`There's no ${what} called "${ref}".`);
  throw new ActionError(`Several ${what}s are called "${ref}"; rename one first.`);
}

const BLANK_TAX_PROFILE = (state: string): TaxProfile => ({
  filingStatus: "single",
  state,
  locality: null,
  dependents: 0,
  earners: [],
  syncPlannedIncome: true,
});
const cents = (dollars: number) => Math.round(dollars * 100);

export async function applyAction(app: FastifyInstance, request: FastifyRequest, a: AiAction): Promise<void> {
  if (CLIENT_ACTION_TYPES.has(a.type)) {
    throw new ActionError("This change is applied by the app, not the server.");
  }
  const categories = async () =>
    (await call<{ categories: Category[] }>(app, request, "GET", "/categories")).categories;

  switch (a.type) {
    case "create_category": {
      const all = await categories();
      const parent = a.parent ? resolveCategory(all, a.parent) : null;
      await call(app, request, "POST", "/categories", {
        name: a.name,
        color: a.color ?? parent?.color ?? DEFAULT_COLOR,
        parentCategoryId: parent?.id ?? null,
        kind: a.kind ?? parent?.kind ?? "expense",
      });
      return;
    }
    case "rename_category": {
      const cat = resolveCategory(await categories(), a.category);
      await call(app, request, "PATCH", `/categories/${cat.id}`, { name: a.newName });
      return;
    }
    case "move_category": {
      const all = await categories();
      const cat = resolveCategory(all, a.category);
      const parent = a.newParent ? resolveCategory(all, a.newParent) : null;
      if (parent && (parent.id === cat.id || isDescendant(all, parent.id, cat.id))) {
        throw new ActionError(`"${cat.name}" can't go inside itself or one of its own branches.`);
      }
      await call(app, request, "PATCH", `/categories/${cat.id}`, { parentCategoryId: parent?.id ?? null });
      return;
    }
    case "recolor_category": {
      const cat = resolveCategory(await categories(), a.category);
      await call(app, request, "PATCH", `/categories/${cat.id}`, { color: a.color });
      return;
    }
    case "delete_category": {
      const cat = resolveCategory(await categories(), a.category);
      await call(app, request, "DELETE", `/categories/${cat.id}`);
      return;
    }
    case "create_rule": {
      const cat = resolveCategory(await categories(), a.category);
      await call(app, request, "POST", "/categorization-rules", { keyword: a.keyword, categoryId: cat.id });
      return;
    }
    case "delete_rule": {
      const { rules } = await call<{ rules: { id: string; keyword: string }[] }>(
        app,
        request,
        "GET",
        "/categorization-rules",
      );
      const matches = rules.filter((r) => r.keyword.toLowerCase() === a.keyword.toLowerCase());
      if (matches.length === 0) throw new ActionError(`There's no rule for "${a.keyword}".`);
      for (const r of matches) await call(app, request, "DELETE", `/categorization-rules/${r.id}`);
      return;
    }
    case "set_budget": {
      const cat = resolveCategory(await categories(), a.category);
      if (a.amount <= 0) throw new ActionError("A budget needs an amount above zero — use remove_budget to drop one.");
      await call(app, request, "POST", "/budgets", { categoryId: cat.id, amountCents: cents(a.amount) });
      return;
    }
    case "remove_budget": {
      const cat = resolveCategory(await categories(), a.category);
      // Budgets carry forward from the month they start; remove every one
      // that still applies so the category really ends up without a budget.
      for (let i = 0; i < 60; i++) {
        const { budgets } = await call<{ budgets: { id: string; categoryId: string }[] }>(app, request, "GET", "/budgets");
        const b = budgets.find((x) => x.categoryId === cat.id);
        if (!b) {
          if (i === 0) throw new ActionError(`"${cat.name}" doesn't have a budget.`);
          return;
        }
        await call(app, request, "DELETE", `/budgets/${b.id}`);
      }
      return;
    }
    case "set_planned_income":
      await call(app, request, "PUT", "/budget-plan", { plannedIncomeCents: cents(a.amount) });
      return;
    case "rename_household":
      await call(app, request, "PATCH", "/household", { name: a.name });
      return;
    case "recategorize": {
      const all = await categories();
      const isNone = (ref: string) => ref.trim().toLowerCase() === UNCATEGORIZED.toLowerCase();
      const target = isNone(a.category) ? null : resolveCategory(all, a.category);
      const from = a.from ? (isNone(a.from) ? "none" : resolveCategory(all, a.from).id) : undefined;
      const { updated } = await call<{ updated: number }>(app, request, "POST", "/transactions/recategorize", {
        merchant: a.merchant,
        categoryId: target?.id ?? null,
        ...(from ? { fromCategoryId: from } : {}),
        ...(a.since ? { since: a.since } : {}),
      });
      if (updated === 0) throw new ActionError(`No transactions matched "${a.merchant}"${a.from ? ` in "${a.from}"` : ""}.`);
      return;
    }
    case "reorder_categories": {
      const all = await categories();
      const parent = a.parent ? resolveCategory(all, a.parent) : null;
      const siblings = all.filter((c) => (c.parentCategoryId ?? null) === (parent?.id ?? null));
      // Income and expense categories are separate lists; a mixed order is
      // applied to each list on its own (models often mix them).
      const listed = a.order.map((name) => resolveCategory(siblings, name));
      for (const kind of ["income", "expense"] as const) {
        const ids = listed.filter((c) => c.kind === kind).map((c) => c.id);
        if (ids.length) await call(app, request, "POST", "/categories/reorder", { orderedIds: ids });
      }
      return;
    }
    case "autocategorize":
      await call(app, request, "POST", "/transactions/autocategorize", {});
      return;

    // ── tax & salary ──
    case "set_tax_profile":
    case "set_salary":
    case "set_pretax":
    case "remove_earner": {
      const { profile } = await call<{ profile: TaxProfile | null }>(app, request, "GET", "/tax-profile");
      const state = a.type === "set_tax_profile" && a.state ? a.state.toUpperCase() : profile?.state;
      if (!state) throw new ActionError("Set the state first (set_tax_profile with a state).");
      const next: TaxProfile = { ...(profile ?? BLANK_TAX_PROFILE(state)), earners: [...(profile?.earners ?? [])] };
      if (a.type === "set_tax_profile") {
        if (a.state) {
          next.state = state;
          if (next.locality && findLocality(next.locality)?.state !== state) next.locality = null;
        }
        if (a.filingStatus) next.filingStatus = a.filingStatus;
        if (a.locality !== undefined) next.locality = a.locality;
        if (a.customLocalRatePct !== undefined) next.customLocalRatePct = a.customLocalRatePct;
        if (a.dependents !== undefined) next.dependents = a.dependents;
        if (a.syncPlannedIncome !== undefined) next.syncPlannedIncome = a.syncPlannedIncome;
      } else if (a.type === "set_salary") {
        const i = next.earners.findIndex((e) => e.name.toLowerCase() === a.earner.trim().toLowerCase());
        const base = i >= 0 ? next.earners[i]! : { name: a.earner.trim(), grossAnnualCents: 0, payFrequency: "biweekly" as const };
        const updated = { ...base, grossAnnualCents: cents(a.grossAnnual), ...(a.payFrequency ? { payFrequency: a.payFrequency } : {}) };
        if (i >= 0) next.earners[i] = updated;
        else next.earners.push(updated);
      } else {
        const earner = resolveNamed(next.earners, a.earner, "earner");
        const i = next.earners.indexOf(earner);
        if (a.type === "remove_earner") next.earners.splice(i, 1);
        else {
          next.earners[i] = {
            ...earner,
            ...(a.retirementPct !== undefined ? { retirementPct: a.retirementPct, retirementCents: null } : {}),
            ...(a.hsaAnnual !== undefined ? { hsaCents: cents(a.hsaAnnual) } : {}),
            ...(a.healthPremiumsAnnual !== undefined ? { healthPremiumCents: cents(a.healthPremiumsAnnual) } : {}),
            ...(a.otherPretaxAnnual !== undefined ? { otherPretaxCents: cents(a.otherPretaxAnnual) } : {}),
          };
        }
      }
      await call(app, request, "PUT", "/tax-profile", next);
      return;
    }

    // ── bills ──
    case "create_bill": {
      const cat = a.category ? resolveCategory(await categories(), a.category) : null;
      await call(app, request, "POST", "/bills", {
        name: a.name,
        amountCents: cents(a.amount),
        dueDay: a.dueDay,
        ...(a.cadence ? { cadence: a.cadence } : {}),
        ...(a.autopay !== undefined ? { autopay: a.autopay } : {}),
        ...(cat ? { categoryId: cat.id, color: cat.color } : {}),
      });
      return;
    }
    case "update_bill":
    case "delete_bill": {
      const { bills } = await call<{ bills: Array<{ id: string; name: string }> }>(app, request, "GET", "/bills");
      const bill = resolveNamed(bills, a.bill, "bill");
      if (a.type === "delete_bill") await call(app, request, "DELETE", `/bills/${bill.id}`);
      else
        await call(app, request, "PATCH", `/bills/${bill.id}`, {
          ...(a.amount !== undefined ? { amountCents: cents(a.amount) } : {}),
          ...(a.dueDay !== undefined ? { dueDay: a.dueDay } : {}),
          ...(a.cadence ? { cadence: a.cadence } : {}),
          ...(a.autopay !== undefined ? { autopay: a.autopay } : {}),
        });
      return;
    }

    // ── goals ──
    case "create_goal":
      await call(app, request, "POST", "/goals", {
        name: a.name,
        targetCents: cents(a.target),
        monthlyCents: cents(a.monthly ?? 0),
        savedCents: cents(a.saved ?? 0),
        ...(a.targetDate ? { targetDate: a.targetDate } : {}),
        color: "#3ecf8e",
      });
      return;
    case "update_goal":
    case "delete_goal": {
      const { goals } = await call<{ goals: Array<{ id: string; name: string }> }>(app, request, "GET", "/goals");
      const goal = resolveNamed(goals, a.goal, "goal");
      if (a.type === "delete_goal") await call(app, request, "DELETE", `/goals/${goal.id}`);
      else
        await call(app, request, "PATCH", `/goals/${goal.id}`, {
          ...(a.target !== undefined ? { targetCents: cents(a.target) } : {}),
          ...(a.monthly !== undefined ? { monthlyCents: cents(a.monthly) } : {}),
          ...(a.saved !== undefined ? { savedCents: cents(a.saved) } : {}),
          ...(a.targetDate !== undefined ? { targetDate: a.targetDate } : {}),
        });
      return;
    }

    // ── savings buckets ──
    case "create_bucket":
    case "update_bucket":
    case "move_bucket_money":
    case "delete_bucket": {
      type B = { id: string; name: string; allocatedCents: number; accountId: string };
      const { accounts } = await call<{ accounts: Array<{ accountId: string; accountName: string; unassignedCents: number; buckets: B[] }> }>(app, request, "GET", "/buckets");
      const all = accounts.flatMap((acct) => acct.buckets);
      if (a.type === "create_bucket") {
        const acct = resolveNamed(accounts.map((x) => ({ ...x, name: x.accountName })), a.account, "account");
        const amount = cents(a.amount ?? 0);
        if (amount > acct.unassignedCents) throw new ActionError(`Only $${(acct.unassignedCents / 100).toFixed(2)} is unassigned in ${acct.accountName}.`);
        const goal = a.goal
          ? resolveNamed((await call<{ goals: Array<{ id: string; name: string }> }>(app, request, "GET", "/goals")).goals, a.goal, "goal")
          : null;
        await call(app, request, "POST", "/buckets", {
          accountId: acct.accountId,
          name: a.name,
          allocatedCents: amount,
          ...(a.target ? { targetCents: cents(a.target) } : {}),
          ...(goal ? { goalId: goal.id } : {}),
        });
        return;
      }
      if (a.type === "move_bucket_money") {
        const isNone = (ref: string) => /^unassigned$/i.test(ref.trim());
        const from = isNone(a.from) ? null : resolveNamed(all, a.from, "bucket");
        const to = isNone(a.to) ? null : resolveNamed(all, a.to, "bucket");
        await call(app, request, "POST", "/buckets/move", { fromBucketId: from?.id ?? null, toBucketId: to?.id ?? null, amountCents: cents(a.amount) });
        return;
      }
      const bucket = resolveNamed(all, a.bucket, "bucket");
      if (a.type === "delete_bucket") await call(app, request, "DELETE", `/buckets/${bucket.id}`);
      else
        await call(app, request, "PATCH", `/buckets/${bucket.id}`, {
          ...(a.amount !== undefined ? { allocatedCents: cents(a.amount) } : {}),
          ...(a.target !== undefined ? { targetCents: a.target === null ? null : cents(a.target) } : {}),
          ...(a.newName ? { name: a.newName } : {}),
        });
      return;
    }

    // ── giving ──
    case "create_giving_fund":
      await call(app, request, "POST", "/giving", {
        name: a.name,
        ...(a.kind ? { kind: a.kind } : {}),
        monthlyCents: cents(a.monthly ?? 0),
        ...(a.target ? { targetCents: cents(a.target) } : {}),
        ...(a.recipient ? { recipient: a.recipient } : {}),
        ...(a.occasionDate ? { occasionDate: a.occasionDate } : {}),
      });
      return;
    case "update_giving_fund":
    case "delete_giving_fund": {
      const { funds } = await call<{ funds: Array<{ id: string; name: string }> }>(app, request, "GET", "/giving");
      const fund = resolveNamed(funds, a.fund, "giving fund");
      if (a.type === "delete_giving_fund") await call(app, request, "DELETE", `/giving/${fund.id}`);
      else
        await call(app, request, "PATCH", `/giving/${fund.id}`, {
          ...(a.monthly !== undefined ? { monthlyCents: cents(a.monthly) } : {}),
          ...(a.target !== undefined ? { targetCents: a.target ? cents(a.target) : null } : {}),
          ...(a.occasionDate !== undefined ? { occasionDate: a.occasionDate } : {}),
        });
      return;
    }

    // ── debt ──
    case "set_pre_income_item":
    case "remove_pre_income_item":
    case "set_pre_income_estimate": {
      const pre = await call<PreIncome>(app, request, "GET", "/pre-income");
      const same = (n: string) => n.trim().toLowerCase() === ("name" in a ? a.name.trim().toLowerCase() : "");
      let { items, useEstimate } = pre;
      if (a.type === "set_pre_income_estimate") useEstimate = a.use;
      else if (a.type === "remove_pre_income_item") {
        if (!items.some((i) => same(i.name))) throw new ActionError(`There's no before-income item called "${a.name}".`);
        items = items.filter((i) => !same(i.name));
      } else {
        const existing = items.find((i) => same(i.name));
        items = existing
          ? items.map((i) => (i === existing ? { ...i, monthlyCents: cents(a.amount), kind: a.kind ?? i.kind } : i))
          : [...items, { id: randomUUID(), name: a.name, kind: a.kind ?? "tax", monthlyCents: cents(a.amount) }];
      }
      await call(app, request, "PUT", "/pre-income", { items, useEstimate });
      return;
    }
    case "set_debt_plan": {
      const plan = await call<Record<string, unknown>>(app, request, "GET", "/debt-plan");
      await call(app, request, "PUT", "/debt-plan", {
        ...plan,
        ...(a.strategy ? { strategy: a.strategy } : {}),
        ...(a.extraMonthly !== undefined ? { extraCents: cents(a.extraMonthly) } : {}),
      });
      return;
    }
    case "set_theme":
    case "set_review_prefs":
      return; // unreachable — handled above
  }
}

/**
 * Rule check for proposed changes, run before the user sees them: replays
 * them in order against a copy of the category tree (so a category created
 * earlier in the same reply counts) and returns why each one would fail, or
 * null. Mirrors what applyAction and the API enforce.
 */
/** Everything the rule check needs, read through the API as this user. */
export async function loadCheckWorld(app: FastifyInstance, request: FastifyRequest): Promise<CheckWorld> {
  const [{ categories }, { bills }, { goals }, { funds }, { profile }, { accounts: bucketAccounts }] = await Promise.all([
    call<{ categories: Category[] }>(app, request, "GET", "/categories"),
    call<{ bills: Array<{ name: string }> }>(app, request, "GET", "/bills"),
    call<{ goals: Array<{ name: string }> }>(app, request, "GET", "/goals"),
    call<{ funds: Array<{ name: string }> }>(app, request, "GET", "/giving"),
    call<{ profile: TaxProfile | null }>(app, request, "GET", "/tax-profile"),
    call<{ accounts: Array<{ accountName: string; buckets: Array<{ name: string }> }> }>(app, request, "GET", "/buckets"),
  ]);
  const preIncome = await call<PreIncome>(app, request, "GET", "/pre-income");
  return {
    categories,
    bills: bills.map((b) => b.name),
    goals: goals.map((g) => g.name),
    funds: funds.map((f) => f.name),
    buckets: bucketAccounts.flatMap((x) => x.buckets.map((b) => b.name)),
    bucketAccounts: bucketAccounts.map((x) => x.accountName),
    taxState: profile?.state ?? null,
    earners: profile?.earners.map((e) => e.name) ?? [],
    preIncome: preIncome.items.map((i) => i.name),
  };
}

export interface CheckWorld {
  categories: Category[];
  bills?: string[];
  goals?: string[];
  funds?: string[];
  /** Savings bucket names and the accounts that can hold buckets. */
  buckets?: string[];
  bucketAccounts?: string[];
  /** The saved tax profile's state and earner names, if there is one. */
  taxState?: string | null;
  earners?: string[];
  preIncome?: string[];
}

export function checkActions(worldOrCategories: CheckWorld | Category[], actions: AiAction[]): Array<string | null> {
  const world: CheckWorld = Array.isArray(worldOrCategories) ? { categories: worldOrCategories } : worldOrCategories;
  const all: Category[] = world.categories.map((c) => ({ ...c }));
  const lower = (xs: string[] | undefined) => new Set((xs ?? []).map((x) => x.trim().toLowerCase()));
  const bills = lower(world.bills);
  const goals = lower(world.goals);
  const funds = lower(world.funds);
  const earners = lower(world.earners);
  const bucketNames = lower(world.buckets);
  const bucketAccounts = lower(world.bucketAccounts);
  const preIncome = lower(world.preIncome);
  let taxState = world.taxState ?? null;
  const named = (set: Set<string>, ref: string, what: string) =>
    set.has(ref.trim().toLowerCase()) ? null : `There's no ${what} called "${ref}".`;
  let fake = 0;
  const isNone = (ref: string) => ref.trim().toLowerCase() === UNCATEGORIZED.toLowerCase();
  const find = (ref: string) => resolveCategory(all, ref);
  const siblingsOf = (parentId: string | null) => all.filter((c) => (c.parentCategoryId ?? null) === parentId);

  return actions.map((a) => {
    try {
      switch (a.type) {
        case "create_category": {
          const parent = a.parent ? find(a.parent) : null;
          if (parent && a.kind && a.kind !== parent.kind) {
            return `"${a.name}" is ${a.kind} but "${parent.name}" is an ${parent.kind} category; put it under an ${a.kind} category or leave kind out.`;
          }
          if (siblingsOf(parent?.id ?? null).some((c) => c.name.toLowerCase() === a.name.toLowerCase())) {
            return `There's already a "${a.name}"${parent ? ` under "${parent.name}"` : " at the top level"}.`;
          }
          all.push({
            ...(parent ?? all[0]!),
            id: `00000000-0000-4000-8000-${String(++fake).padStart(12, "0")}`,
            name: a.name,
            parentCategoryId: parent?.id ?? null,
            kind: a.kind ?? parent?.kind ?? "expense",
            isSystem: false,
          });
          return null;
        }
        case "rename_category": {
          const cat = find(a.category);
          if (siblingsOf(cat.parentCategoryId ?? null).some((c) => c.id !== cat.id && c.name.toLowerCase() === a.newName.toLowerCase())) {
            return `"${cat.name}" can't be renamed to "${a.newName}": a sibling already has that name.`;
          }
          cat.name = a.newName;
          return null;
        }
        case "move_category": {
          const cat = find(a.category);
          const parent = a.newParent ? find(a.newParent) : null;
          if (parent && (parent.id === cat.id || isDescendant(all, parent.id, cat.id))) {
            return `"${cat.name}" can't go inside itself or one of its own branches.`;
          }
          if (parent && parent.kind !== cat.kind) {
            return `"${cat.name}" is an ${cat.kind} category and "${parent.name}" is ${parent.kind}; they can't be nested.`;
          }
          cat.parentCategoryId = parent?.id ?? null;
          return null;
        }
        case "recolor_category":
        case "create_rule":
        case "remove_budget":
          find(a.category);
          return null;
        case "delete_category": {
          const cat = find(a.category);
          if (cat.isSystem) return `"${cat.name}" is built in and can't be deleted (rename or move it instead).`;
          if (all.some((c) => c.parentCategoryId === cat.id)) return `"${cat.name}" still has categories inside it; move them out first.`;
          all.splice(all.indexOf(cat), 1);
          return null;
        }
        case "set_budget": {
          const cat = find(a.category);
          if (cat.kind !== "expense") return `"${cat.name}" is an income category; budgets are for spending categories.`;
          if (a.amount <= 0) return "A budget needs an amount above zero (use remove_budget to drop one).";
          return null;
        }
        case "recategorize":
          if (!isNone(a.category)) find(a.category);
          if (a.from && !isNone(a.from)) find(a.from);
          return null;
        case "reorder_categories": {
          const parent = a.parent ? find(a.parent) : null;
          const siblings = siblingsOf(parent?.id ?? null);
          const missing = a.order.filter((name) => {
            try {
              resolveCategory(siblings, name);
              return false;
            } catch {
              return true;
            }
          });
          if (missing.length) {
            return `Not directly ${parent ? `under "${parent.name}"` : "at the top level"}: ${missing.join(", ")}. Order only categories that share that parent.`;
          }
          return null;
        }
        case "set_tax_profile": {
          const state = a.state?.toUpperCase() ?? taxState;
          if (a.state && !(a.state.toUpperCase() in STATES_2026)) return `"${a.state}" isn't a US state code (use two letters, like CO).`;
          if (!state) return "Include the state (two-letter code) the first time the tax profile is set up.";
          if (a.locality) {
            const loc = findLocality(a.locality);
            if (!loc) return `There's no local tax "${a.locality}"; use a tax_places look-up for the ids, or customLocalRatePct.`;
            if (loc.state !== state) return `${loc.name} is in ${loc.state}, not ${state}.`;
          }
          taxState = state;
          return null;
        }
        case "set_salary":
          if (!taxState) return "Set the tax profile's state first (set_tax_profile with state) in the same reply.";
          earners.add(a.earner.trim().toLowerCase());
          return null;
        case "set_pretax":
          return named(earners, a.earner, "earner");
        case "remove_earner": {
          const err = named(earners, a.earner, "earner");
          if (!err) earners.delete(a.earner.trim().toLowerCase());
          return err;
        }
        case "create_bill":
          if (a.category) find(a.category);
          if (bills.has(a.name.toLowerCase())) return `There's already a bill called "${a.name}" (use update_bill).`;
          bills.add(a.name.toLowerCase());
          return null;
        case "update_bill":
          return named(bills, a.bill, "bill");
        case "delete_bill": {
          const err = named(bills, a.bill, "bill");
          if (!err) bills.delete(a.bill.toLowerCase());
          return err;
        }
        case "create_goal":
          if (a.target <= 0) return "A goal needs a target above zero.";
          if (goals.has(a.name.toLowerCase())) return `There's already a goal called "${a.name}" (use update_goal).`;
          goals.add(a.name.toLowerCase());
          return null;
        case "update_goal":
          return named(goals, a.goal, "goal");
        case "delete_goal": {
          const err = named(goals, a.goal, "goal");
          if (!err) goals.delete(a.goal.toLowerCase());
          return err;
        }
        case "create_bucket": {
          const acctErr = named(bucketAccounts, a.account, "savings or checking account");
          if (acctErr) return acctErr;
          if (a.goal && !goals.has(a.goal.trim().toLowerCase())) return `There's no goal called "${a.goal}".`;
          if (bucketNames.has(a.name.toLowerCase())) return `There's already a bucket called "${a.name}" (use update_bucket).`;
          bucketNames.add(a.name.toLowerCase());
          return null;
        }
        case "update_bucket":
          return named(bucketNames, a.bucket, "bucket");
        case "delete_bucket": {
          const err = named(bucketNames, a.bucket, "bucket");
          if (!err) bucketNames.delete(a.bucket.toLowerCase());
          return err;
        }
        case "move_bucket_money":
          for (const ref of [a.from, a.to]) {
            if (/^unassigned$/i.test(ref.trim())) continue;
            const err = named(bucketNames, ref, "bucket");
            if (err) return err;
          }
          return a.from.trim().toLowerCase() === a.to.trim().toLowerCase() ? "Move between two different buckets." : null;
        case "create_giving_fund":
          if (funds.has(a.name.toLowerCase())) return `There's already a giving fund called "${a.name}" (use update_giving_fund).`;
          funds.add(a.name.toLowerCase());
          return null;
        case "update_giving_fund":
          return named(funds, a.fund, "giving fund");
        case "delete_giving_fund": {
          const err = named(funds, a.fund, "giving fund");
          if (!err) funds.delete(a.fund.toLowerCase());
          return err;
        }
        case "set_pre_income_item":
          if (a.amount <= 0) return `Give "${a.name}" a monthly amount above zero, or use remove_pre_income_item.`;
          preIncome.add(a.name.trim().toLowerCase());
          return null;
        case "remove_pre_income_item": {
          const err = named(preIncome, a.name, "before-income item");
          if (!err) preIncome.delete(a.name.trim().toLowerCase());
          return err;
        }
        default:
          return null;
      }
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  });
}

function isDescendant(all: Category[], id: string, ancestorId: string): boolean {
  const byId = new Map(all.map((c) => [c.id, c]));
  for (let cur = byId.get(id), n = 0; cur && n < 50; cur = cur.parentCategoryId ? byId.get(cur.parentCategoryId) : undefined, n++) {
    if (cur.parentCategoryId === ancestorId) return true;
  }
  return false;
}

/**
 * The part of the system prompt that teaches the model how to look things up
 * and propose changes, for the agents this message needs (agents.ts), plus
 * the data those agents work with (category tree, tax profile, bills…) so it
 * names real rows.
 */
export async function buildActionGuide(app: FastifyInstance, request: FastifyRequest, agentIds: AgentId[] = AGENTS.map((a) => a.id)): Promise<string> {
  const agents = AGENTS.filter((a) => agentIds.includes(a.id));
  const has = (id: AgentId) => agentIds.includes(id);
  const others = AGENTS.filter((a) => !agentIds.includes(a.id)).map((a) => a.name);

  const lines: string[] = [
    "",
    ...STYLE_AND_LIMITS,
    "",
    "=== CHANGING THINGS ===",
    "You have no function or tool calls: <vault-action> and <vault-query> are plain",
    "text tags you write in your reply.",
    `Specialist agents active for this message: ${agents.map((a) => a.name).join(", ")}.`,
    ...(others.length ? [`(Also available if the user asks: ${others.join(", ")}.)`] : []),
    "Only propose a change when the user asks for it or clearly agrees to one.",
    "To propose a change, put ONE JSON object per block on its own line:",
    '<vault-action>{"type":"set_budget","category":"Groceries","amount":400}</vault-action>',
    "ALWAYS write at least one sentence to the user stating what you're proposing;",
    "the app shows each change as a card the user approves (or it applies",
    "automatically in auto mode).",
    "",
    "=== LOOKING THINGS UP ===",
    "The snapshot is short. To see more before answering or proposing changes,",
    "put look-ups on their own lines and STOP writing; the results come back to",
    "you and you continue (a few rounds per message):",
    '<vault-query>{"type":"category_totals","months":3}</vault-query>',
    "",
  ];
  for (const a of agents) {
    lines.push(`--- ${a.name} agent ---`);
    if (a.queries.length) lines.push("Look-ups:", ...a.queries);
    if (a.actions.length) lines.push("Changes:", ...a.actions);
    if (a.tips?.length) lines.push(...a.tips);
    if (a.examples?.length) lines.push("Examples:", ...a.examples);
    lines.push("");
  }
  lines.push(
    "RULES (changes that break these are sent back to you to fix):",
    "  - Make only the changes the user asked for; don't reorganize other things.",
    "  - Never add up or estimate amounts yourself: transactions and category_totals",
    "    look-ups give exact totals for any merchant, category or date range.",
    "  - Income and expense categories are separate trees: never nest one inside",
    "    the other; reorder_categories only orders siblings (same parent).",
    "  - Budgets are only for expense categories.",
    "  - Built-in categories can't be deleted; a category with sub-categories",
    "    can't be deleted until they're moved out.",
    "  - Only use names (categories, bills, goals, funds, earners) that exist below",
    "    or that you create earlier in the same reply.",
    "",
    "=== MEMORY ===",
    "To remember a lasting fact or preference about the user for future chats",
    "(goals, preferences, household facts — never passwords or account numbers),",
    "add: <vault-remember>Prefers weekly reviews on Sunday evenings</vault-remember>",
    "Don't re-save things already listed under REMEMBERED.",
  );

  // The data the active agents act on.
  if (has("organizer") || has("budget") || has("bills")) {
    const { categories } = await call<{ categories: Category[] }>(app, request, "GET", "/categories");
    const byParent = new Map<string | null, Category[]>();
    for (const c of categories) {
      const list = byParent.get(c.parentCategoryId) ?? [];
      list.push(c);
      byParent.set(c.parentCategoryId, list);
    }
    const tree: string[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const c of byParent.get(parent) ?? []) {
        if (tree.length > 150) return;
        tree.push(`${"  ".repeat(depth + 1)}- ${c.name} (${c.kind}${c.isSystem ? ", built-in" : ""})`);
        if (depth < 6) walk(c.id, depth + 1);
      }
    };
    walk(null, 0);
    lines.push("", 'CATEGORY TREE (name categories exactly; if two share a name use "Parent > Child"):', ...(tree.length ? tree : ["  (none)"]));
    if (has("organizer")) {
      const { rules } = await call<{ rules: { keyword: string; categoryId: string }[] }>(app, request, "GET", "/categorization-rules");
      const catName = new Map(categories.map((c) => [c.id, c.name]));
      lines.push(
        "AUTO-CATEGORIZATION RULES (keyword → category):",
        ...(rules.length ? rules.slice(0, 60).map((r) => `  "${r.keyword}" → ${catName.get(r.categoryId) ?? "?"}`) : ["  (none)"]),
      );
    }
  }
  if (has("tax")) {
    const { profile } = await call<{ profile: TaxProfile | null }>(app, request, "GET", "/tax-profile");
    lines.push(
      "",
      "TAX PROFILE:",
      ...(profile
        ? [
            `  ${profile.filingStatus.replace(/_/g, " ")}, ${profile.state}${profile.locality ? ` (${profile.locality})` : ""}, ${profile.dependents} child(ren) under 17`,
            ...profile.earners.map((e) => `  earner "${e.name}": $${Math.round(e.grossAnnualCents / 100).toLocaleString("en-US")}/yr gross, paid ${e.payFrequency}${e.retirementPct ? `, 401(k) ${e.retirementPct}%` : ""}`),
          ]
        : ["  (not set up yet — set it up from what the user said, or ask for salary and where they live)"]),
      "LOCAL TAX ids (state: id = place):",
      ...[...new Set(LOCALITIES_2026.map((l) => l.state))].map(
        (st) => `  ${st}: ${LOCALITIES_2026.filter((l) => l.state === st).map((l) => `${l.id} = ${l.name}`).join("; ")}`,
      ),
    );
  }
  if (has("tax")) {
    const pre = await call<PreIncome>(app, request, "GET", "/pre-income");
    lines.push(
      `BEFORE-INCOME ITEMS (estimated taxes ${pre.useEstimate ? "also shown" : "turned off"}):`,
      ...(pre.items.length ? pre.items.map((i) => `  "${i.name}" | ${i.kind} | $${(i.monthlyCents / 100).toFixed(2)}/mo`) : ["  (none)"]),
    );
  }
  const named = async (agent: AgentId, url: string, key: string, label: string) => {
    if (!has(agent)) return;
    const body = await call<Record<string, Array<{ name: string }>>>(app, request, "GET", url);
    const names = (body[key] ?? []).map((x) => `"${x.name}"`);
    lines.push(`${label}: ${names.length ? names.slice(0, 40).join(", ") : "(none)"}`);
  };
  await named("bills", "/bills", "bills", "BILLS");
  await named("goals", "/goals", "goals", "SAVINGS GOALS");
  await named("giving", "/giving", "funds", "GIVING FUNDS");
  return lines.join("\n");
}
