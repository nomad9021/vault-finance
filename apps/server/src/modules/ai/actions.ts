import {
  CLIENT_ACTION_TYPES,
  describeAiAction,
  UNCATEGORIZED,
  type AiAction,
  type AiActionRecord,
  type Category,
} from "@vault/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { aiActions } from "../../db/schema.js";

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
      const ids = a.order.map((name) => resolveCategory(siblings, name).id);
      await call(app, request, "POST", "/categories/reorder", { orderedIds: ids });
      return;
    }
    case "autocategorize":
      await call(app, request, "POST", "/transactions/autocategorize", {});
      return;
    case "set_theme":
    case "set_review_prefs":
      return; // unreachable — handled above
  }
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
    "=== CHANGING THINGS ===",
    `Specialist agents active for this message: ${agents.map((a) => a.name).join(", ")}.`,
    ...(others.length ? [`(Also available if the user asks: ${others.join(", ")}.)`] : []),
    "You can NOT change security settings, members, bank links, AI settings, or",
    "transaction amounts/dates — say so if asked.",
    "Only propose a change when the user asks for it or clearly agrees to one.",
    "To propose a change, put ONE JSON object per block on its own line:",
    '<vault-action>{"type":"create_category","name":"Pets","parent":"Household"}</vault-action>',
    "Briefly say what you're proposing in plain words too; the app shows each",
    "change as a card the user approves (or it applies automatically in auto mode).",
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
    lines.push("");
  }
  lines.push(
    "RULES (changes that break these are sent back to you to fix):",
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
        : ["  (not set up yet — ask for salary, state and filing status, then use set_tax_profile + set_salary)"]),
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
