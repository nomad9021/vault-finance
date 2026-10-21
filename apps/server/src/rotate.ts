import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eq, isNotNull, isNull, sql } from "drizzle-orm";
import { aiSettings, bankConnections, bankSettings, deviceKeys, deviceSessions, users } from "./db/schema.js";
import type { Db } from "./plugins/db.js";
import { configureSecretCryptoWithKey, decryptSecret, encryptSecret } from "./secret-crypto.js";
import { loadAllMemory, saveAllMemory } from "./lib/ai-memory.js";

/**
 * Rotation of the server's own secrets, for when one is (or may have been)
 * exposed. Run from the server console; see docs/operations.md §8.
 */

/** Other connections to this database — the running server holds some. */
export async function otherConnections(db: Db): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()`,
  );
  return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
}

/**
 * Re-encrypt every secret column under a brand-new data key.
 *
 * The new key is written to `data-key.new` before the database changes and
 * renamed over `data-key` after they commit, so a crash in between leaves
 * both keys on disk and re-running finishes the job. With VAULT_DATA_KEY set
 * (key kept outside the data dir) the new key is returned for the operator
 * to store instead.
 */
export async function rotateDataKey(
  db: Db,
  dataDir: string,
  envKey: string | undefined,
): Promise<{ newKeyForEnv?: string; rotated: number }> {
  const keyPath = path.join(dataDir, "data-key");
  const nextPath = `${keyPath}.new`;
  const oldKey = envKey
    ? Buffer.from(envKey, "base64")
    : Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");

  // Resume an interrupted rotation: if the pending key already decrypts the
  // data, the database was rotated — only the rename is left.
  let newKey = randomBytes(32);
  if (!envKey && existsSync(nextPath)) newKey = Buffer.from(readFileSync(nextPath, "utf8").trim(), "base64");

  const plain = await readAllSecrets(db, [oldKey, newKey]);
  const memory = loadAllMemory(dataDir, (v) => decryptWithAny(v, [oldKey, newKey]));
  if (!envKey) writeFileSync(nextPath, newKey.toString("base64"), { mode: 0o600 });

  configureSecretCryptoWithKey(newKey);
  await db.transaction(async (tx) => {
    for (const u of plain.users) {
      await tx.update(users).set({ totpSecret: encryptSecret(u.value) }).where(eq(users.id, u.id));
    }
    for (const c of plain.connections) {
      await tx.update(bankConnections).set({ accessToken: encryptSecret(c.value) }).where(eq(bankConnections.id, c.id));
    }
    if (plain.plaidSecret !== null) {
      await tx.update(bankSettings).set({ plaidSecret: encryptSecret(plain.plaidSecret) }).where(eq(bankSettings.id, true));
    }
    if (plain.aiKey !== null) {
      await tx.update(aiSettings).set({ apiKey: encryptSecret(plain.aiKey) }).where(eq(aiSettings.id, true));
    }
  });
  const memoryNotes = saveAllMemory(memory);
  const rotated =
    memoryNotes +
    plain.users.length + plain.connections.length + (plain.plaidSecret !== null ? 1 : 0) + (plain.aiKey !== null ? 1 : 0);

  if (envKey) return { newKeyForEnv: newKey.toString("base64"), rotated };
  renameSync(nextPath, keyPath);
  return { rotated };
}

/** Decrypt every secret column, trying each key in turn (old, then a pending new one). */
function decryptWithAny(v: string, keys: Buffer[]): string {
  let lastErr: unknown;
  for (const k of keys) {
    configureSecretCryptoWithKey(k);
    try {
      return decryptSecret(v);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`A stored secret can't be decrypted with the current data key (${String(lastErr)}). Nothing was changed.`);
}

async function readAllSecrets(db: Db, keys: Buffer[]) {
  const decrypt = (v: string): string => decryptWithAny(v, keys);
  const userRows = await db.select({ id: users.id, v: users.totpSecret }).from(users).where(isNotNull(users.totpSecret));
  const connRows = await db
    .select({ id: bankConnections.id, v: bankConnections.accessToken })
    .from(bankConnections)
    .where(isNotNull(bankConnections.accessToken));
  const bank = await db.query.bankSettings.findFirst();
  const ai = await db.query.aiSettings.findFirst();
  return {
    users: userRows.map((r) => ({ id: r.id, value: decrypt(r.v!) })),
    connections: connRows.map((r) => ({ id: r.id, value: decrypt(r.v!) })),
    plaidSecret: bank?.plaidSecret ? decrypt(bank.plaidSecret) : null,
    aiKey: ai?.apiKey ? decrypt(ai.apiKey) : null,
  };
}

/** New random JWT signing secret; every access token stops working on restart. */
export function rotateJwtSecret(dataDir: string): void {
  writeFileSync(path.join(dataDir, "jwt-secret"), randomBytes(48).toString("base64url"), { mode: 0o600 });
}

/** End every sign-in and delete every biometric device key. */
export async function signOutEveryone(db: Db): Promise<{ sessions: number; deviceKeys: number }> {
  const s = await db
    .update(deviceSessions)
    .set({ revokedAt: new Date() })
    .where(isNull(deviceSessions.revokedAt))
    .returning({ id: deviceSessions.id });
  const k = await db.delete(deviceKeys).returning({ id: deviceKeys.id });
  return { sessions: s.length, deviceKeys: k.length };
}
