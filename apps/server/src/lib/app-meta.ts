import { sql } from "drizzle-orm";
import { appMeta } from "../db/schema.js";
import type { Db } from "../plugins/db.js";

/** Well-known app_meta keys, so two modules can't collide on a string. */
export const META_KEYS = {
  householdName: "household_name",
} as const;

export async function readMeta(db: Db, key: string): Promise<string | null> {
  const [row] = await db.select().from(appMeta).where(sql`${appMeta.key} = ${key}`);
  return row?.value ?? null;
}

export async function writeMeta(db: Db, key: string, value: string): Promise<void> {
  await db
    .insert(appMeta)
    .values({ key, value })
    .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt: new Date() } });
}
