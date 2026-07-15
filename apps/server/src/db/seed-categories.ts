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
}> = [
  { name: "Income", icon: "coins", color: "#3ecf8e" },
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
  await db
    .insert(categories)
    .values(DEFAULT_CATEGORIES.map((c) => ({ ...c, isSystem: true })))
    .onConflictDoNothing();
}
