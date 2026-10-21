import { z } from "zod";

/**
 * Changes the AI assistant may propose. The model names categories the way
 * the user sees them (by name, "Parent > Child" when ambiguous); the server
 * resolves names to ids when the change is applied, so a proposal approved
 * later still lands on the right row.
 *
 * Deliberately absent: anything security-related (passwords, 2FA, devices,
 * sessions, members), bank links, the AI provider itself, and transaction
 * amounts, dates or deletion — for transactions it can only change the
 * category, in bulk by merchant.
 */

const Name = z.string().trim().min(1).max(60);
const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
/** Whole or decimal dollars, as the model writes them. */
const Dollars = z.number().nonnegative().max(10_000_000);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Look-up windows, coerced and clamped rather than rejected. */
const Days = z.coerce.number().int().min(1).transform((n) => Math.min(n, 730));
const Months = z.coerce.number().int().min(1).transform((n) => Math.min(n, 24));
/** "Uncategorized" is accepted wherever a source category is named. */
export const UNCATEGORIZED = "Uncategorized";

export const AiAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_category"),
    name: Name,
    /** Parent category name; omitted for a top-level category. */
    parent: Name.nullish(),
    kind: z.enum(["expense", "income"]).optional(),
    color: Color.optional(),
  }),
  z.object({ type: z.literal("rename_category"), category: Name, newName: Name }),
  z.object({ type: z.literal("move_category"), category: Name, newParent: Name.nullable() }),
  z.object({ type: z.literal("recolor_category"), category: Name, color: Color }),
  z.object({ type: z.literal("delete_category"), category: Name }),
  z.object({ type: z.literal("create_rule"), keyword: z.string().trim().min(1).max(100), category: Name }),
  z.object({ type: z.literal("delete_rule"), keyword: z.string().trim().min(1).max(100) }),
  z.object({ type: z.literal("set_budget"), category: Name, amount: Dollars }),
  z.object({ type: z.literal("remove_budget"), category: Name }),
  z.object({ type: z.literal("set_planned_income"), amount: Dollars }),
  z.object({ type: z.literal("rename_household"), name: z.string().trim().min(1).max(80) }),
  /** Move every transaction whose merchant contains `merchant` into `category`. */
  z.object({
    type: z.literal("recategorize"),
    merchant: z.string().trim().min(2).max(100),
    category: Name,
    /** Only transactions currently in this category ("Uncategorized" for none). */
    from: Name.optional(),
    since: Day.optional(),
  }),
  /** Put sibling categories in this order (it's the order the trees and the Sankey use). */
  z.object({
    type: z.literal("reorder_categories"),
    parent: Name.nullable(),
    order: z.array(Name).min(2).max(60),
  }),
  /** Run the auto-categorization rules (and AI, if on) over uncategorized transactions. */
  z.object({ type: z.literal("autocategorize") }),

  // ── Tax & salary agent ──
  z.object({
    type: z.literal("set_tax_profile"),
    filingStatus: z.enum(["single", "married_joint", "married_separate", "head_of_household"]).optional(),
    state: z.string().regex(/^[A-Za-z]{2}$/).optional(),
    /** Locality id from the tax places list, or null for none. */
    locality: z.string().max(40).nullable().optional(),
    customLocalRatePct: z.number().min(0).max(10).nullable().optional(),
    dependents: z.number().int().min(0).max(20).optional(),
    syncPlannedIncome: z.boolean().optional(),
  }),
  /** Set (or add) an earner's salary before tax. */
  z.object({
    type: z.literal("set_salary"),
    earner: Name,
    grossAnnual: Dollars,
    payFrequency: z.enum(["weekly", "biweekly", "semimonthly", "monthly"]).optional(),
  }),
  z.object({
    type: z.literal("set_pretax"),
    earner: Name,
    retirementPct: z.number().min(0).max(100).optional(),
    hsaAnnual: Dollars.optional(),
    healthPremiumsAnnual: Dollars.optional(),
    otherPretaxAnnual: Dollars.optional(),
  }),
  z.object({ type: z.literal("remove_earner"), earner: Name }),

  // ── Bills agent ──
  z.object({
    type: z.literal("create_bill"),
    name: Name,
    amount: Dollars,
    dueDay: z.number().int().min(1).max(31),
    cadence: z.enum(["weekly", "monthly", "quarterly", "yearly"]).optional(),
    autopay: z.boolean().optional(),
    category: Name.optional(),
  }),
  z.object({
    type: z.literal("update_bill"),
    bill: Name,
    amount: Dollars.optional(),
    dueDay: z.number().int().min(1).max(31).optional(),
    cadence: z.enum(["weekly", "monthly", "quarterly", "yearly"]).optional(),
    autopay: z.boolean().optional(),
  }),
  z.object({ type: z.literal("delete_bill"), bill: Name }),

  // ── Goals agent ──
  z.object({
    type: z.literal("create_goal"),
    name: Name,
    target: Dollars,
    monthly: Dollars.optional(),
    saved: Dollars.optional(),
    targetDate: Day.optional(),
  }),
  z.object({
    type: z.literal("update_goal"),
    goal: Name,
    target: Dollars.optional(),
    monthly: Dollars.optional(),
    saved: Dollars.optional(),
    targetDate: Day.nullable().optional(),
  }),
  z.object({ type: z.literal("delete_goal"), goal: Name }),
  // Savings buckets (split an account's balance into named parts)
  z.object({
    type: z.literal("create_bucket"),
    account: Name,
    name: Name,
    amount: Dollars.optional(),
    target: Dollars.optional(),
    goal: Name.optional(),
  }),
  z.object({ type: z.literal("update_bucket"), bucket: Name, amount: Dollars.optional(), target: Dollars.nullable().optional(), newName: Name.optional() }),
  /** from/to are bucket names, or "Unassigned". */
  z.object({ type: z.literal("move_bucket_money"), from: Name, to: Name, amount: Dollars }),
  z.object({ type: z.literal("delete_bucket"), bucket: Name }),

  // ── Giving agent ──
  z.object({
    type: z.literal("create_giving_fund"),
    name: Name,
    kind: z.enum(["giving", "gift"]).optional(),
    monthly: Dollars.optional(),
    target: Dollars.optional(),
    recipient: z.string().trim().max(120).optional(),
    occasionDate: Day.optional(),
  }),
  z.object({
    type: z.literal("update_giving_fund"),
    fund: Name,
    monthly: Dollars.optional(),
    target: Dollars.optional(),
    occasionDate: Day.nullable().optional(),
  }),
  z.object({ type: z.literal("delete_giving_fund"), fund: Name }),

  // ── Debt agent ──
  z.object({
    type: z.literal("set_debt_plan"),
    strategy: z.enum(["avalanche", "snowball"]).optional(),
    extraMonthly: Dollars.optional(),
  }),
  // Applied by the app itself (they're per-device preferences).
  z.object({ type: z.literal("set_theme"), theme: z.string().min(1).max(20) }),
  z.object({
    type: z.literal("set_review_prefs"),
    defaultPeriod: z.enum(["week", "month"]).optional(),
    weekStartsOn: z.enum(["monday", "sunday"]).optional(),
    compare: z.boolean().optional(),
    autoAdvanceSeconds: z.number().int().min(0).max(120).optional(),
    startFullscreen: z.boolean().optional(),
    showSlides: z.array(z.string()).optional(),
    hideSlides: z.array(z.string()).optional(),
  }),
]);
export type AiAction = z.infer<typeof AiAction>;
export type AiActionType = AiAction["type"];

/** Action types the desktop app applies locally rather than the server. */
export const CLIENT_ACTION_TYPES: ReadonlySet<AiActionType> = new Set(["set_theme", "set_review_prefs"]);

export const AiActionStatus = z.enum(["pending", "applied", "rejected", "failed"]);
export type AiActionStatus = z.infer<typeof AiActionStatus>;

export const AiActionRecord = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  messageId: z.string().uuid().nullable(),
  action: AiAction,
  /** Plain-language description: "Add category Pets under Household". */
  summary: z.string(),
  /** True when the app (not the server) carries it out. */
  client: z.boolean(),
  status: AiActionStatus,
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type AiActionRecord = z.infer<typeof AiActionRecord>;

/** Reporting the outcome of an action the app applied itself. */
export const AiActionClientResult = z.object({
  status: z.enum(["applied", "failed", "rejected"]),
  error: z.string().max(500).optional(),
});
export type AiActionClientResult = z.infer<typeof AiActionClientResult>;

export const AiMemoryNote = z.object({
  at: z.string().datetime(),
  text: z.string(),
});
export type AiMemoryNote = z.infer<typeof AiMemoryNote>;

export const AiMemoryResponse = z.object({ notes: z.array(AiMemoryNote) });
export type AiMemoryResponse = z.infer<typeof AiMemoryResponse>;

/** Plain-language summary of an action, for the approval card and history. */
export function describeAiAction(a: AiAction): string {
  switch (a.type) {
    case "create_category":
      return `Add ${a.kind === "income" ? "income " : ""}category "${a.name}"${a.parent ? ` under "${a.parent}"` : ""}`;
    case "rename_category":
      return `Rename category "${a.category}" to "${a.newName}"`;
    case "move_category":
      return a.newParent
        ? `Move category "${a.category}" under "${a.newParent}"`
        : `Make "${a.category}" a top-level category`;
    case "recolor_category":
      return `Change the colour of "${a.category}" to ${a.color}`;
    case "delete_category":
      return `Delete category "${a.category}"`;
    case "create_rule":
      return `Auto-categorize transactions matching "${a.keyword}" as "${a.category}"`;
    case "delete_rule":
      return `Remove the auto-categorization rule for "${a.keyword}"`;
    case "set_budget":
      return `Set the monthly budget for "${a.category}" to $${a.amount.toLocaleString("en-US")}`;
    case "remove_budget":
      return `Remove the budget for "${a.category}"`;
    case "set_planned_income":
      return `Set planned monthly income to $${a.amount.toLocaleString("en-US")}`;
    case "rename_household":
      return `Rename the household to "${a.name}"`;
    case "recategorize":
      return `Move ${a.from ? `"${a.from}" ` : ""}transactions from "${a.merchant}"${a.since ? ` since ${a.since}` : ""} to "${a.category}"`;
    case "reorder_categories":
      return `Order ${a.parent ? `the categories under "${a.parent}"` : "the top-level categories"}: ${a.order.join(", ")}`;
    case "autocategorize":
      return "Auto-categorize uncategorized transactions";
    case "set_tax_profile": {
      const parts: string[] = [];
      if (a.filingStatus) parts.push(`file as ${a.filingStatus.replace(/_/g, " ")}`);
      if (a.state) parts.push(`live in ${a.state.toUpperCase()}`);
      if (a.locality !== undefined) parts.push(a.locality ? `local tax: ${a.locality}` : "no local tax");
      if (a.customLocalRatePct != null) parts.push(`local tax ${a.customLocalRatePct}%`);
      if (a.dependents !== undefined) parts.push(`${a.dependents} child${a.dependents === 1 ? "" : "ren"} under 17`);
      if (a.syncPlannedIncome !== undefined) parts.push(a.syncPlannedIncome ? "budget from take-home" : "keep budget income separate");
      return `Tax profile: ${parts.join("; ") || "no change"}`;
    }
    case "set_salary":
      return `Set ${a.earner}'s salary to $${a.grossAnnual.toLocaleString("en-US")} a year before tax${a.payFrequency ? `, paid ${a.payFrequency}` : ""}`;
    case "set_pretax": {
      const parts: string[] = [];
      if (a.retirementPct !== undefined) parts.push(`401(k) ${a.retirementPct}%`);
      if (a.hsaAnnual !== undefined) parts.push(`HSA $${a.hsaAnnual.toLocaleString("en-US")}/yr`);
      if (a.healthPremiumsAnnual !== undefined) parts.push(`premiums $${a.healthPremiumsAnnual.toLocaleString("en-US")}/yr`);
      if (a.otherPretaxAnnual !== undefined) parts.push(`other pre-tax $${a.otherPretaxAnnual.toLocaleString("en-US")}/yr`);
      return `${a.earner}'s pre-tax deductions: ${parts.join(", ") || "no change"}`;
    }
    case "remove_earner":
      return `Remove ${a.earner} from the tax profile`;
    case "create_bill":
      return `Add bill "${a.name}": $${a.amount.toLocaleString("en-US")} ${a.cadence ?? "monthly"}, due on day ${a.dueDay}`;
    case "update_bill":
      return `Update bill "${a.bill}"`;
    case "delete_bill":
      return `Delete bill "${a.bill}"`;
    case "create_goal":
      return `Add savings goal "${a.name}": $${a.target.toLocaleString("en-US")}${a.monthly ? `, $${a.monthly.toLocaleString("en-US")}/month` : ""}`;
    case "update_goal":
      return `Update savings goal "${a.goal}"`;
    case "delete_goal":
      return `Delete savings goal "${a.goal}"`;
    case "create_bucket":
      return `Add bucket "${a.name}" in ${a.account}${a.amount ? ` with $${a.amount.toLocaleString("en-US")}` : ""}${a.target ? `, target $${a.target.toLocaleString("en-US")}` : ""}`;
    case "update_bucket":
      return `Update bucket "${a.bucket}"`;
    case "move_bucket_money":
      return `Move $${a.amount.toLocaleString("en-US")} from ${a.from} to ${a.to}`;
    case "delete_bucket":
      return `Delete bucket "${a.bucket}"`;
    case "create_giving_fund":
      return `Add ${a.kind === "gift" ? "gift" : "giving"} fund "${a.name}"${a.monthly ? `, $${a.monthly.toLocaleString("en-US")}/month` : ""}`;
    case "update_giving_fund":
      return `Update giving fund "${a.fund}"`;
    case "delete_giving_fund":
      return `Delete giving fund "${a.fund}"`;
    case "set_debt_plan":
      return `Debt plan: ${[a.strategy && `${a.strategy} order`, a.extraMonthly !== undefined && `$${a.extraMonthly.toLocaleString("en-US")} extra a month`].filter(Boolean).join(", ") || "no change"}`;
    case "set_theme":
      return `Switch the theme to ${a.theme}`;
    case "set_review_prefs": {
      const parts: string[] = [];
      if (a.defaultPeriod) parts.push(`default to ${a.defaultPeriod}ly reviews`);
      if (a.weekStartsOn) parts.push(`start weeks on ${a.weekStartsOn}`);
      if (a.compare !== undefined) parts.push(a.compare ? "show comparisons" : "hide comparisons");
      if (a.autoAdvanceSeconds !== undefined)
        parts.push(a.autoAdvanceSeconds ? `auto-advance every ${a.autoAdvanceSeconds}s` : "turn off auto-advance");
      if (a.startFullscreen !== undefined) parts.push(a.startFullscreen ? "present in full screen" : "present in a window");
      if (a.showSlides?.length) parts.push(`show ${a.showSlides.join(", ")}`);
      if (a.hideSlides?.length) parts.push(`hide ${a.hideSlides.join(", ")}`);
      return `Finance reviews: ${parts.join("; ") || "no change"}`;
    }
  }
}

// Tolerant of the ways small models mangle the tag: a missing "<" or ">",
// stray text before it ("$vault-action{…}") or a ```json fence inside.
const ACTION_RE = /<?vault-action>?([\s\S]*?)<\/vault-action>/g;
const REMEMBER_RE = /<vault-remember>([\s\S]*?)<\/vault-remember>/g;
const QUERY_RE = /<?vault-query>?([\s\S]*?)<\/vault-query>/g;

/** A block's JSON without the code fences some models wrap it in. */
const blockJson = (raw: string) =>
  raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    // Curly quotes (some models' typography) aren't JSON.
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"');

/**
 * Look-ups the assistant asks the server for mid-answer (the agent loop):
 * plain text, so every model can use them, with or without native tool
 * calling. Read-only by design — changes still go through <vault-action>.
 */
export const AiQuery = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("transactions"),
    merchant: z.string().trim().min(1).max(100).optional(),
    category: Name.optional(),
    from: Day.optional(),
    to: Day.optional(),
    /** Last N days (instead of from/to). */
    days: Days.optional(),
    limit: z.coerce.number().int().min(1).transform((n) => Math.min(n, 100)).optional(),
  }),
  z.object({
    type: z.literal("merchants"),
    months: Months.optional(),
    days: Days.optional(),
    uncategorizedOnly: z.boolean().optional(),
  }),
  z.object({ type: z.literal("category_totals"), months: Months.optional(), days: Days.optional() }),
  z.object({ type: z.literal("budgets") }),
  z.object({ type: z.literal("tax_estimate") }),
  /** The saved tax profile with some things changed — nothing is saved. */
  z.object({
    type: z.literal("tax_whatif"),
    state: z.string().regex(/^[A-Za-z]{2}$/).optional(),
    locality: z.string().max(40).nullable().optional(),
    filingStatus: z.enum(["single", "married_joint", "married_separate", "head_of_household"]).optional(),
    dependents: z.number().int().min(0).max(20).optional(),
    earner: Name.optional(),
    grossAnnual: z.number().nonnegative().max(10_000_000).optional(),
    retirementPct: z.number().min(0).max(100).optional(),
  }),
  z.object({ type: z.literal("tax_compare"), states: z.array(z.string().regex(/^[A-Za-z]{2}$/)).min(1).max(10) }),
  z.object({ type: z.literal("tax_places"), state: z.string().regex(/^[A-Za-z]{2}$/) }),
  z.object({ type: z.literal("bills") }),
  z.object({ type: z.literal("subscriptions") }),
  z.object({ type: z.literal("goals") }),
  z.object({ type: z.literal("buckets") }),
  z.object({ type: z.literal("giving") }),
  z.object({ type: z.literal("debts") }),
  z.object({ type: z.literal("cashflow"), months: z.number().int().min(1).max(24).optional() }),
  z.object({ type: z.literal("insights") }),
  z.object({ type: z.literal("accounts") }),
]);
export type AiQuery = z.infer<typeof AiQuery>;

/** The look-ups in a reply; malformed ones come back as raw text to report to the model. */
/**
 * Look-up names models invent for the real ones ("merchant_totals" for a
 * merchant's transactions); mapped rather than rejected.
 */
const QUERY_ALIASES: Record<string, string> = {
  merchant_totals: "transactions",
  merchant_total: "transactions",
  merchant_spending: "transactions",
  transaction_totals: "transactions",
  spending: "transactions",
  totals: "transactions",
  search: "transactions",
  transaction: "transactions",
  category_spending: "category_totals",
  categories: "category_totals",
  category_total: "category_totals",
  merchant: "merchants",
  budget: "budgets",
  bill: "bills",
  goal: "goals",
  account: "accounts",
};

export function extractQueryBlocks(text: string): { queries: AiQuery[]; invalid: string[] } {
  const queries: AiQuery[] = [];
  const invalid: string[] = [];
  for (const m of text.matchAll(QUERY_RE)) {
    const raw = (m[1] ?? "").trim();
    try {
      const obj = JSON.parse(blockJson(raw)) as Record<string, unknown>;
      if (typeof obj?.type === "string" && QUERY_ALIASES[obj.type]) obj.type = QUERY_ALIASES[obj.type];
      const parsed = AiQuery.safeParse(obj);
      if (parsed.success) queries.push(parsed.data);
      else invalid.push(raw);
    } catch {
      invalid.push(raw);
    }
  }
  return { queries, invalid };
}

/**
 * Pull action and memory blocks out of an assistant reply. Returns the
 * visible text (blocks removed) plus what was found; malformed actions are
 * reported, not thrown, so one bad block can't sink the reply.
 */
export function extractAssistantBlocks(text: string): {
  visible: string;
  actions: AiAction[];
  invalid: string[];
  remember: string[];
} {
  const actions: AiAction[] = [];
  const invalid: string[] = [];
  const remember: string[] = [];
  for (const m of text.matchAll(ACTION_RE)) {
    const raw = (m[1] ?? "").trim();
    try {
      const parsed = AiAction.safeParse(JSON.parse(blockJson(raw)));
      if (parsed.success) actions.push(parsed.data);
      else invalid.push(raw);
    } catch {
      invalid.push(raw);
    }
  }
  for (const m of text.matchAll(REMEMBER_RE)) {
    const note = (m[1] ?? "").trim().slice(0, 500);
    if (note) remember.push(note);
  }
  return { visible: stripAssistantBlocks(text), actions, invalid, remember };
}

/**
 * Remove action/memory blocks for display — including a block still being
 * streamed (an opening tag with no close yet).
 */
export function stripAssistantBlocks(text: string): string {
  return text
    .replace(ACTION_RE, "")
    .replace(REMEMBER_RE, "")
    .replace(QUERY_RE, "")
    .replace(/<?vault-(action|remember|query)>?[\s\S]*$/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
