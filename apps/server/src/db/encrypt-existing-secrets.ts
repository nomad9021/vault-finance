import { eq, isNotNull } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { encryptSecret, isEncrypted } from "../secret-crypto.js";
import type { Db } from "../plugins/db.js";
import { aiSettings, bankSettings, users } from "./schema.js";

/**
 * One-time upgrade of secret columns written before column encryption existed.
 *
 * This can't be a SQL migration — the key lives in the data dir, not the
 * database — so it runs at boot, after migrations. It is idempotent: rows
 * already carrying the `v1.` prefix are skipped, so a normal restart does
 * nothing and costs one indexed scan of three tiny tables.
 */
export async function encryptExistingSecrets(db: Db, log: FastifyBaseLogger): Promise<void> {
  let migrated = 0;

  const userRows = await db
    .select({ id: users.id, totpSecret: users.totpSecret })
    .from(users)
    .where(isNotNull(users.totpSecret));
  for (const row of userRows) {
    if (!row.totpSecret || isEncrypted(row.totpSecret)) continue;
    await db
      .update(users)
      .set({ totpSecret: encryptSecret(row.totpSecret) })
      .where(eq(users.id, row.id));
    migrated++;
  }

  const bank = await db.query.bankSettings.findFirst();
  if (bank?.plaidSecret && !isEncrypted(bank.plaidSecret)) {
    await db
      .update(bankSettings)
      .set({ plaidSecret: encryptSecret(bank.plaidSecret) })
      .where(eq(bankSettings.id, true));
    migrated++;
  }

  const ai = await db.query.aiSettings.findFirst();
  if (ai?.apiKey && !isEncrypted(ai.apiKey)) {
    await db
      .update(aiSettings)
      .set({ apiKey: encryptSecret(ai.apiKey) })
      .where(eq(aiSettings.id, true));
    migrated++;
  }

  if (migrated > 0) {
    // Deliberately counts only — never log the values themselves.
    log.info({ migrated }, "encrypted secrets previously stored in plaintext");
  }
}
