import { z } from "zod";

/**
 * Changes the AI assistant may propose. The model names categories the way
 * the user sees them (by name, "Parent > Child" when ambiguous); the server
 * resolves names to ids when the change is applied, so a proposal approved
 * later still lands on the right row.
 *
 * Deliberately absent: anything security-related (passwords, 2FA, devices,
 * sessions, members), bank links, the AI provider itself, and transactions.
 */

const Name = z.string().trim().min(1).max(60);
const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
/** Whole or decimal dollars, as the model writes them. */
const Dollars = z.number().nonnegative().max(10_000_000);

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

const ACTION_RE = /<vault-action>([\s\S]*?)<\/vault-action>/g;
const REMEMBER_RE = /<vault-remember>([\s\S]*?)<\/vault-remember>/g;

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
      const parsed = AiAction.safeParse(JSON.parse(raw));
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
    .replace(/<vault-(action|remember)>[\s\S]*$/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
