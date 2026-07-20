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

export const BankConnection = z.object({
  id: z.string().uuid(),
  provider: BankProvider,
  institutionName: z.string(),
  /** Accounts this connection created/owns. */
  accountCount: z.number().int(),
  createdAt: z.string(),
  lastSyncedAt: z.string().nullable(),
});
export type BankConnection = z.infer<typeof BankConnection>;

export const BankStatus = z.object({
  enabled: z.boolean(),
  provider: BankProvider,
  /** True when the chosen provider has what it needs to run (mock always does). */
  configured: z.boolean(),
  /** Never returns the secret — only whether Plaid credentials are stored. */
  hasPlaidCredentials: z.boolean(),
  plaidEnv: z.enum(["sandbox", "development", "production"]),
  connections: z.array(BankConnection),
});
export type BankStatus = z.infer<typeof BankStatus>;

export const UpdateBankSettingsRequest = z
  .object({
    enabled: z.boolean(),
    provider: BankProvider,
    plaidClientId: z.string().max(200).optional(),
    plaidSecret: z.string().max(200).optional(),
    plaidEnv: z.enum(["sandbox", "development", "production"]).optional(),
  })
  .refine((v) => v.provider !== "plaid" || !v.enabled || true, { message: "" });
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
