import type { JWK } from "jose";
import type {
  BankAccountData,
  BankProviderClient,
  BankTransactionData,
  ConnectResult,
  ConnectionRef,
  InternalAccountType,
  TransactionSync,
} from "./types.js";

/**
 * Plaid provider over raw REST (no SDK dependency, same style as the Ollama
 * client).
 *
 * Linking uses Plaid **Hosted Link**: Plaid hosts the bank sign-in page, the
 * desktop app opens it in the browser, and the server polls /link/token/get
 * for the result. That needs no public URL or webhook, which suits a server
 * that only lives on your LAN or Tailscale, and Plaid handles OAuth banks
 * itself.
 *
 * Privacy: every call here sends data to Plaid under the owner's own keys —
 * this is the third-party hop the UI warns about (ADR-0007).
 */

export interface PlaidConfig {
  clientId: string;
  secret: string;
  env: "sandbox" | "production";
  /** Overrides the derived base URL (used to point at a mock in tests). */
  baseUrl?: string;
}

const ENV_BASE: Record<PlaidConfig["env"], string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

/** Plaid errors that mean "the owner has to sign in to the bank again". */
const RECONNECT_CODES = new Set([
  "ITEM_LOGIN_REQUIRED",
  "PENDING_EXPIRATION",
  "PENDING_DISCONNECT",
  "INVALID_UPDATED_USERNAME",
  "USER_PERMISSION_REVOKED",
  "ACCESS_NOT_GRANTED",
]);

export class PlaidError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly code: string,
    /** Plaid's own end-user wording, when it gives one. */
    readonly displayMessage: string | null,
    message: string,
  ) {
    super(message);
    this.name = "PlaidError";
  }
  get needsReconnect(): boolean {
    return RECONNECT_CODES.has(this.code);
  }
}

/** Plain-language explanation for the owner. */
export function describePlaidError(err: unknown): string {
  if (!(err instanceof PlaidError)) return err instanceof Error ? err.message : String(err);
  if (err.needsReconnect) return "The bank wants you to sign in again. Press Reconnect.";
  switch (err.code) {
    case "INVALID_API_KEYS":
      return "Plaid rejected the client ID or secret. Check them in Settings → Bank (and that the environment matches the keys).";
    case "INVALID_PRODUCT":
    case "PRODUCTS_NOT_SUPPORTED":
      return "Your Plaid account isn't enabled for Transactions in this environment. Request it in the Plaid Dashboard.";
    case "INSTITUTION_NOT_RESPONDING":
    case "INSTITUTION_DOWN":
      return "The bank isn't responding to Plaid right now. Try again later.";
    case "RATE_LIMIT_EXCEEDED":
      return "Plaid is rate-limiting requests. Try again in a few minutes.";
    default:
      return err.displayMessage ?? `Plaid error ${err.code}: ${err.message}`;
  }
}

function mapType(type: string, subtype: string | null): InternalAccountType {
  if (type === "credit") return "credit_card";
  if (type === "loan") return subtype === "mortgage" ? "mortgage" : "loan";
  if (type === "investment" || type === "brokerage") return "investment";
  if (type === "depository") return subtype === "savings" ? "savings" : "checking";
  return "other";
}

interface PlaidTxn {
  transaction_id: string;
  account_id: string;
  date: string;
  amount: number;
  name: string;
  merchant_name: string | null;
  pending: boolean;
}

function toTxn(t: PlaidTxn): BankTransactionData {
  return {
    externalId: t.transaction_id,
    externalAccountId: t.account_id,
    postedAt: t.date,
    // Plaid: positive amount = money out. App: negative = spending.
    amountCents: -Math.round(t.amount * 100),
    merchantName: t.merchant_name ?? t.name,
    ...(t.pending ? { description: "Pending" } : {}),
  };
}

export interface LinkSessionResult {
  /** The person finished (successfully or not). */
  finished: boolean;
  /** One per bank they connected. */
  publicTokens: Array<{ publicToken: string; institutionName: string | null }>;
  /** They closed Plaid without connecting, with Plaid's reason if any. */
  exited: boolean;
  exitMessage: string | null;
}

export class PlaidBankProvider implements BankProviderClient {
  private readonly base: string;
  constructor(private readonly cfg: PlaidConfig) {
    this.base = (cfg.baseUrl ?? ENV_BASE[cfg.env]).replace(/\/$/, "");
  }

  private async call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: this.cfg.clientId, secret: this.cfg.secret, ...body }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let e: { error_code?: string; error_message?: string; display_message?: string | null } = {};
      try {
        e = JSON.parse(text) as typeof e;
      } catch {
        /* not JSON */
      }
      throw new PlaidError(
        path,
        res.status,
        e.error_code ?? `HTTP_${res.status}`,
        e.display_message ?? null,
        e.error_message ?? text.slice(0, 300),
      );
    }
    return (await res.json()) as T;
  }

  /** Local demo connections only — real banks go through Hosted Link. */
  async connect(): Promise<ConnectResult> {
    throw new Error("Plaid banks are linked through Plaid's sign-in page (Link a bank), not connect().");
  }

  /**
   * Start a Hosted Link session. With `accessToken`, it's update mode: the
   * owner signs in to an existing bank again instead of adding a new one.
   */
  async createLinkSession(opts: {
    clientUserId: string;
    clientName: string;
    accessToken?: string;
  }): Promise<{ linkToken: string; url: string; expiresAt: string }> {
    const res = await this.call<{ link_token: string; hosted_link_url?: string; expiration: string }>(
      "/link/token/create",
      {
        client_name: opts.clientName.slice(0, 30),
        language: "en",
        country_codes: ["US"],
        user: { client_user_id: opts.clientUserId },
        ...(opts.accessToken
          ? { access_token: opts.accessToken }
          : { products: ["transactions"], transactions: { days_requested: 730 } }),
        hosted_link: { url_lifetime_seconds: 1800 },
      },
    );
    if (!res.hosted_link_url) {
      throw new Error("Plaid didn't return a Hosted Link URL. Hosted Link may not be enabled for your Plaid account.");
    }
    return { linkToken: res.link_token, url: res.hosted_link_url, expiresAt: res.expiration };
  }

  /** Poll a Hosted Link session (Plaid keeps the details 6 hours after it ends). */
  async getLinkSession(linkToken: string): Promise<LinkSessionResult> {
    const res = await this.call<{
      link_sessions?: Array<{
        finished_at?: string | null;
        results?: {
          item_add_results?: Array<{ public_token: string; institution?: { name?: string } | null }>;
        } | null;
        exit?: { error?: { display_message?: string | null; error_message?: string } | null } | null;
      }>;
    }>("/link/token/get", { link_token: linkToken });

    const sessions = res.link_sessions ?? [];
    const finished = sessions.some((s) => !!s.finished_at);
    const publicTokens = sessions.flatMap((s) =>
      (s.results?.item_add_results ?? []).map((r) => ({
        publicToken: r.public_token,
        institutionName: r.institution?.name ?? null,
      })),
    );
    const exit = sessions.find((s) => s.exit)?.exit ?? null;
    return {
      finished,
      publicTokens,
      exited: exit !== null,
      exitMessage: exit?.error?.display_message ?? exit?.error?.error_message ?? null,
    };
  }

  /** Swap Link's one-time public token for the long-lived access token. */
  async exchange(publicToken: string): Promise<{ itemId: string; accessToken: string }> {
    const r = await this.call<{ access_token: string; item_id: string }>("/item/public_token/exchange", {
      public_token: publicToken,
    });
    return { itemId: r.item_id, accessToken: r.access_token };
  }

  /** The bank's display name for an item, or null if Plaid can't say. */
  async institutionName(accessToken: string): Promise<string | null> {
    try {
      const item = await this.call<{ item: { institution_id: string | null } }>("/item/get", {
        access_token: accessToken,
      });
      if (!item.item.institution_id) return null;
      const inst = await this.call<{ institution: { name: string } }>("/institutions/get_by_id", {
        institution_id: item.item.institution_id,
        country_codes: ["US"],
      });
      return inst.institution.name;
    } catch {
      return null;
    }
  }

  /** Tell Plaid to forget the item (stops billing and data access). */
  /** The public key Plaid signed a webhook with (see bank/webhook-verify.ts). */
  async webhookVerificationKey(keyId: string): Promise<JWK & { expired_at: number | null }> {
    const res = await this.call<{ key: JWK & { expired_at: number | null } }>(
      "/webhook_verification_key/get",
      { key_id: keyId },
    );
    return res.key;
  }

  async removeItem(accessToken: string): Promise<void> {
    await this.call("/item/remove", { access_token: accessToken });
  }

  async listAccounts(conn: ConnectionRef): Promise<BankAccountData[]> {
    if (!conn.accessToken) throw new Error("Plaid connection is missing its access token");
    const data = await this.call<{
      accounts: Array<{
        account_id: string;
        name: string;
        mask: string | null;
        type: string;
        subtype: string | null;
        balances: { current: number | null; available: number | null; iso_currency_code: string | null };
      }>;
    }>("/accounts/get", { access_token: conn.accessToken });

    return data.accounts.map((a) => {
      const type = mapType(a.type, a.subtype);
      const raw = a.balances.current ?? a.balances.available ?? 0;
      const liability = type === "credit_card" || type === "loan" || type === "mortgage";
      return {
        externalAccountId: a.account_id,
        name: a.name,
        type,
        ...(a.mask ? { mask: a.mask } : {}),
        balanceCents: Math.round(raw * 100) * (liability ? -1 : 1),
        currency: a.balances.iso_currency_code ?? "USD",
      };
    });
  }

  /**
   * Everything since `cursor`. Follows Plaid's rules for /transactions/sync:
   * page until has_more is false, and if the data changes mid-way
   * (TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION) start the whole update again
   * from the original cursor. An empty next_cursor means the bank's first
   * pull isn't ready yet — keep the old cursor and try on the next sync.
   */
  async syncTransactions(conn: ConnectionRef, cursor: string | null): Promise<TransactionSync> {
    if (!conn.accessToken) throw new Error("Plaid connection is missing its access token");
    for (let attempt = 0; attempt < 3; attempt++) {
      const out: TransactionSync = { added: [], modified: [], removedIds: [], cursor };
      let next = cursor;
      try {
        for (let page = 0; page < 200; page++) {
          const r = await this.call<{
            added: PlaidTxn[];
            modified: PlaidTxn[];
            removed: Array<{ transaction_id: string }>;
            has_more: boolean;
            next_cursor: string;
          }>("/transactions/sync", {
            access_token: conn.accessToken,
            count: 500,
            ...(next ? { cursor: next } : {}),
          });
          out.added.push(...r.added.map(toTxn));
          out.modified.push(...r.modified.map(toTxn));
          out.removedIds.push(...r.removed.map((x) => x.transaction_id));
          if (r.next_cursor) next = r.next_cursor;
          if (!r.has_more) {
            out.cursor = next;
            return out;
          }
        }
        throw new Error("Plaid kept returning more pages; stopped after 100,000 transactions.");
      } catch (err) {
        if (err instanceof PlaidError && err.code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") continue;
        throw err;
      }
    }
    throw new Error("Plaid's data kept changing during sync; try again in a minute.");
  }
}
