import type { BankProvider } from "@vault/shared";
import { MockBankProvider } from "./mock.js";
import { PlaidBankProvider } from "./plaid.js";
import type { BankProviderClient } from "./types.js";

export type { BankAccountData, BankProviderClient, BankTransactionData, ConnectionRef, TransactionSync } from "./types.js";
export { PlaidBankProvider, PlaidError, describePlaidError } from "./plaid.js";

export interface BankProviderConfig {
  provider: BankProvider;
  plaidClientId: string | null;
  plaidSecret: string | null;
  plaidEnv: "sandbox" | "production";
  plaidBaseUrl?: string;
}

/** True when the chosen provider has everything it needs to run. */
export function isConfigured(cfg: BankProviderConfig): boolean {
  if (cfg.provider === "mock") return true;
  return !!cfg.plaidClientId && !!cfg.plaidSecret;
}

/** The Plaid client, for the Link endpoints that only Plaid has. */
export function getPlaid(cfg: BankProviderConfig): PlaidBankProvider {
  if (!cfg.plaidClientId || !cfg.plaidSecret) {
    throw new Error("Plaid is selected but its client id/secret aren't set");
  }
  return new PlaidBankProvider({
    clientId: cfg.plaidClientId,
    secret: cfg.plaidSecret,
    env: cfg.plaidEnv,
    ...(cfg.plaidBaseUrl ? { baseUrl: cfg.plaidBaseUrl } : {}),
  });
}

export function getBankProvider(cfg: BankProviderConfig): BankProviderClient {
  if (cfg.provider === "plaid") {
    if (!cfg.plaidClientId || !cfg.plaidSecret) {
      throw new Error("Plaid is selected but its client id/secret aren't set");
    }
    return new PlaidBankProvider({
      clientId: cfg.plaidClientId,
      secret: cfg.plaidSecret,
      env: cfg.plaidEnv,
      ...(cfg.plaidBaseUrl ? { baseUrl: cfg.plaidBaseUrl } : {}),
    });
  }
  return new MockBankProvider();
}
