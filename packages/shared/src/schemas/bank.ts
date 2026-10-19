import { z } from "zod";

/**
 * Optional bank linking (ADR-0007). Off by default. The "mock" provider
 * fabricates data locally — nothing leaves the server; "plaid" routes through
 * Plaid under the owner's own keys, which is the privacy tradeoff the UI warns
 * about before it can be enabled.
 */

export const BankProvider = z.enum(["mock", "plaid"]);
export type BankProvider = z.infer<typeof BankProvider>;

export const BANK_PROVIDER_LABELS: Record<BankProvider, string> = {
  mock: "Sandbox (local demo data)",
  plaid: "Plaid",
};

/**
 * Plaid environments. Development was shut down by Plaid on 2024-06-20;
 * Sandbox uses test banks, Production your real ones (needs Plaid's approval).
 */
export const PlaidEnv = z.enum(["sandbox", "production"]);
export type PlaidEnv = z.infer<typeof PlaidEnv>;

export const BankConnection = z.object({
  id: z.string().uuid(),
  provider: BankProvider,
  institutionName: z.string(),
  /** Accounts this connection created/owns. */
  accountCount: z.number().int(),
  createdAt: z.string(),
  lastSyncedAt: z.string().nullable(),
  /** The bank wants you to sign in again (password changed, consent expired…). */
  needsReconnect: z.boolean(),
});
export type BankConnection = z.infer<typeof BankConnection>;

export const BankStatus = z.object({
  enabled: z.boolean(),
  provider: BankProvider,
  /** True when the chosen provider has what it needs to run (mock always does). */
  configured: z.boolean(),
  /** Never returns the secret — only whether Plaid credentials are stored. */
  hasPlaidCredentials: z.boolean(),
  plaidEnv: PlaidEnv,
  connections: z.array(BankConnection),
});
export type BankStatus = z.infer<typeof BankStatus>;

export const UpdateBankSettingsRequest = z
  .object({
    enabled: z.boolean(),
    provider: BankProvider,
    plaidClientId: z.string().max(200).optional(),
    plaidSecret: z.string().max(200).optional(),
    plaidEnv: PlaidEnv.optional(),
  });
export type UpdateBankSettingsRequest = z.infer<typeof UpdateBankSettingsRequest>;

/** Result of connecting or syncing a bank connection. */
export const BankSyncResponse = z.object({
  connectionId: z.string().uuid(),
  institutionName: z.string(),
  accountsLinked: z.number().int(),
  imported: z.number().int(),
  skippedDuplicates: z.number().int(),
});
export type BankSyncResponse = z.infer<typeof BankSyncResponse>;

/**
 * Linking a real bank with Plaid Hosted Link: the server starts a session and
 * returns a Plaid URL to open in the browser; the app then polls until the
 * person finishes (or gives up). With `connectionId`, it re-signs-in an
 * existing connection instead of adding a new one.
 */
export const BankLinkStartRequest = z.object({ connectionId: z.string().uuid().optional() });
export type BankLinkStartRequest = z.infer<typeof BankLinkStartRequest>;

export const BankLinkStartResponse = z.object({
  sessionId: z.string(),
  url: z.string().url(),
  expiresAt: z.string(),
});
export type BankLinkStartResponse = z.infer<typeof BankLinkStartResponse>;

export const BankLinkStatus = z.object({
  status: z.enum(["waiting", "connected", "reconnected", "exited", "expired", "failed"]),
  results: z.array(BankSyncResponse),
  message: z.string().optional(),
});
export type BankLinkStatus = z.infer<typeof BankLinkStatus>;
