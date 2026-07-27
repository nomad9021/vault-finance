import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { categories } from "./schema.js";

/** Accepts a database or an open transaction — anything that can insert. */
type Insertable = Pick<PostgresJsDatabase<Record<string, never>>, "insert">;

/**
 * Default categories seeded by the setup wizard. Colors come from the Nocturne
 * design reference's category palette (design/reference/Finance App v3.dc.html)
 * so the first-run experience matches the design out of the box.
 */
export const DEFAULT_CATEGORIES: ReadonlyArray<{
  name: string;
  icon: string;
  color: string;
  kind?: "income" | "expense";
}> = [
  // Income sources (kind: income) — itemized on the Income page.
  { name: "Salary", icon: "coins", color: "#3ecf8e", kind: "income" },
  { name: "Side Income", icon: "briefcase", color: "#43cfc0", kind: "income" },
  { name: "Gifts", icon: "gift", color: "#ec6a9c", kind: "income" },
  { name: "Interest", icon: "percent", color: "#6f8ef2", kind: "income" },
  // Expense categories (kind: expense) — shape the spending Sankey.
  { name: "Mortgage & Rent", icon: "house", color: "#ef8354" },
  { name: "Groceries", icon: "shopping-cart", color: "#3ecf8e" },
  { name: "Dining Out", icon: "fork-knife", color: "#ec6a9c" },
  { name: "Transport", icon: "car", color: "#4da3f0" },
  { name: "Insurance", icon: "shield-check", color: "#8a94a6" },
  { name: "Shopping", icon: "bag", color: "#b47ef0" },
  { name: "Utilities", icon: "lightning", color: "#d8b23c" },
  { name: "Health", icon: "heartbeat", color: "#43cfc0" },
  { name: "Subscriptions", icon: "arrows-clockwise", color: "#e0a030" },
  { name: "Debt Payments", icon: "bank", color: "#e25c5c" },
  { name: "Savings", icon: "piggy-bank", color: "#3ecf8e" },
  { name: "Investments", icon: "trend-up", color: "#6f8ef2" },
  { name: "Everything Else", icon: "dots-three-circle", color: "#9aa0ab" },
];

export async function seedDefaultCategories(db: Insertable): Promise<void> {
  // sortOrder is per-kind, so income and expense each start their own sequence.
  const perKind: Record<string, number> = { income: 0, expense: 0 };
  await db
    .insert(categories)
    .values(
      DEFAULT_CATEGORIES.map((c) => {
        const kind = c.kind ?? "expense";
        return {
          name: c.name,
          icon: c.icon,
          color: c.color,
          kind,
          sortOrder: perKind[kind]!++,
          isSystem: true,
        };
      }),
    )
    .onConflictDoNothing();
}
