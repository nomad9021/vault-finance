/**
 * Uniform bank-provider interface. The routes never branch on provider — they
 * call connect / listAccounts / syncTransactions and let the dispatcher pick
 * the implementation (mock or plaid), mirroring the AI provider abstraction.
 */

export type InternalAccountType =
  | "checking"
  | "savings"
  | "credit_card"
  | "investment"
  | "loan"
  | "mortgage"
  | "other";

export interface BankAccountData {
  externalAccountId: string;
  name: string;
  type: InternalAccountType;
  mask?: string;
  balanceCents: number;
  currency: string;
}

export interface BankTransactionData {
  /** Provider's stable id — used for idempotent import dedupe. */
  externalId: string;
  externalAccountId: string;
  /** YYYY-MM-DD. */
  postedAt: string;
  /** Negative = money out (spending), positive = money in, per app convention. */
  amountCents: number;
  merchantName: string;
  description?: string;
}

export interface ConnectResult {
  externalItemId: string;
  /** Provider access token; null for the mock provider. */
  accessToken: string | null;
  institutionName: string;
}

/** A stored connection, as the provider needs it to make calls. */
export interface ConnectionRef {
  externalItemId: string;
  accessToken: string | null;
}

export interface BankProviderClient {
  /** Establish a new sandbox/mock connection (no interactive Link widget). */
  connect(): Promise<ConnectResult>;
  listAccounts(conn: ConnectionRef): Promise<BankAccountData[]>;
  syncTransactions(conn: ConnectionRef): Promise<BankTransactionData[]>;
}
