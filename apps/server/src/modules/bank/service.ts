import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../plugins/db.js";
import { accounts, bankConnections, bankSettings, transactions, users } from "../../db/schema.js";
import { aiCategorizeUncategorized, loadCategorizer } from "../categorize/service.js";
import { decryptSecret } from "../../secret-crypto.js";
import {
  getBankProvider,
  isConfigured,
  type BankProviderConfig,
  type ConnectionRef,
} from "./providers/index.js";

export type BankSettingsRow = typeof bankSettings.$inferSelect;
export type BankConnectionRow = typeof bankConnections.$inferSelect;

/** Load the singleton settings row, creating it if the migration seed is absent. */
export async function loadBankSettings(db: Db): Promise<BankSettingsRow> {
  const existing = await db.select().from(bankSettings).limit(1);
  if (existing[0]) return existing[0];
  await db.insert(bankSettings).values({ id: true }).onConflictDoNothing();
  const [row] = await db.select().from(bankSettings).limit(1);
  return row!;
}

export function providerConfig(settings: BankSettingsRow, plaidBaseUrl?: string): BankProviderConfig {
  return {
    provider: settings.provider,
    plaidClientId: settings.plaidClientId,
    plaidSecret: decryptSecret(settings.plaidSecret),
    plaidEnv: settings.plaidEnv,
    ...(plaidBaseUrl ? { plaidBaseUrl } : {}),
  };
}

export interface SyncOutcome {
  accountsLinked: number;
  imported: number;
  skippedDuplicates: number;
}

/**
 * Pull the provider's accounts and transactions into the app. Provider
 * balances are authoritative (they reflect all history), so synced accounts
 * take the provider's balance directly and transaction inserts do NOT adjust
 * balances — that avoids double-counting. Transactions dedupe on
 * (accountId, externalId) so re-syncing is idempotent, and each imported row
 * runs through the local categorizer.
 */
export async function syncConnection(
  db: Db,
  cfg: BankProviderConfig,
  connection: BankConnectionRow,
  ownerUserId: string,
): Promise<SyncOutcome> {
  const provider = getBankProvider(cfg);
  const conn: ConnectionRef = {
    externalItemId: connection.externalItemId,
    accessToken: connection.accessToken,
  };

  const provAccounts = await provider.listAccounts(conn);
  const acctIdByExternal = new Map<string, string>();
  const currencyByExternal = new Map<string, string>();
  for (const pa of provAccounts) {
    currencyByExternal.set(pa.externalAccountId, pa.currency);
    const [existing] = await db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.bankConnectionId, connection.id),
          eq(accounts.externalAccountId, pa.externalAccountId),
        ),
      )
      .limit(1);
    if (existing) {
      // Refresh the balance from the provider but keep the account's current
      // name — the user may have renamed it, and a sync must not clobber that.
      await db
        .update(accounts)
        .set({ balanceCents: pa.balanceCents, updatedAt: new Date() })
        .where(eq(accounts.id, existing.id));
      acctIdByExternal.set(pa.externalAccountId, existing.id);
    } else {
      const [created] = await db
        .insert(accounts)
        .values({
          ownerUserId,
          name: pa.name,
          type: pa.type,
          institution: connection.institutionName,
          mask: pa.mask ?? null,
          currency: pa.currency,
          balanceCents: pa.balanceCents,
          bankConnectionId: connection.id,
          externalAccountId: pa.externalAccountId,
        })
        .returning();
      acctIdByExternal.set(pa.externalAccountId, created!.id);
    }
  }

  const categorizer = await loadCategorizer(db);
  const provTxns = await provider.syncTransactions(conn);
  let imported = 0;
  let skippedDuplicates = 0;
  for (const t of provTxns) {
    const accountId = acctIdByExternal.get(t.externalAccountId);
    if (!accountId) continue;
    const inserted = await db
      .insert(transactions)
      .values({
        accountId,
        categoryId: categorizer.suggest(t.merchantName)?.categoryId ?? null,
        postedAt: t.postedAt,
        amountCents: t.amountCents,
        currency: currencyByExternal.get(t.externalAccountId) ?? "USD",
        merchantName: t.merchantName,
        description: t.description ?? null,
        externalId: t.externalId,
      })
      .onConflictDoNothing({
        target: [transactions.accountId, transactions.externalId],
        where: sql`external_id is not null`,
      })
      .returning({ id: transactions.id });
    if (inserted.length > 0) imported++;
    else skippedDuplicates++;
  }

  await db
    .update(bankConnections)
    .set({ lastSyncedAt: new Date() })
    .where(eq(bankConnections.id, connection.id));

  return { accountsLinked: provAccounts.length, imported, skippedDuplicates };
}

/**
 * Sync every bank connection — used by the background scheduler and by the
 * Plaid webhook. No-ops unless bank linking is on and configured. Runs the
 * AI-leftovers categorization once at the end so freshly-imported rows are
 * sorted. Never throws: one bad connection can't stop the rest.
 */
export async function syncAllConnections(
  app: FastifyInstance,
  config: AppConfig,
): Promise<{ connections: number; imported: number }> {
  const settings = await loadBankSettings(app.db);
  const cfg = providerConfig(settings, config.plaidBaseUrl);
  if (!settings.enabled || !isConfigured(cfg)) return { connections: 0, imported: 0 };

  const conns = await app.db.select().from(bankConnections);
  if (conns.length === 0) return { connections: 0, imported: 0 };
  const owner = await app.db.query.users.findFirst({ where: eq(users.role, "owner") });
  if (!owner) return { connections: 0, imported: 0 };

  let imported = 0;
  for (const c of conns) {
    try {
      const r = await syncConnection(app.db, cfg, c, owner.id);
      imported += r.imported;
    } catch (err) {
      app.log.error({ err, connectionId: c.id }, "auto-sync failed for connection");
    }
  }
  await aiCategorizeUncategorized(app, config).catch(() => {});
  return { connections: conns.length, imported };
}
