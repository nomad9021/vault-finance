import type {
  BankAccountData,
  BankProviderClient,
  BankTransactionData,
  ConnectResult,
  ConnectionRef,
  InternalAccountType,
} from "./types.js";

/**
 * Plaid provider over raw REST (no SDK dependency, same style as the Ollama
 * client). The prototype uses the Sandbox flow: /sandbox/public_token/create
 * skips Plaid's interactive Link widget, so the whole pipeline works
 * server-side. Swap the env to point at real Plaid later.
 *
 * Privacy: every call here sends data to Plaid under the owner's own keys —
 * this is the third-party hop the UI warns about (ADR-0007).
 */

export interface PlaidConfig {
  clientId: string;
  secret: string;
  env: "sandbox" | "development" | "production";
  /** Overrides the derived base URL (used to point at a mock in tests). */
  baseUrl?: string;
}

const ENV_BASE: Record<PlaidConfig["env"], string> = {
  sandbox: "https://sandbox.plaid.com",
  development: "https://development.plaid.com",
  production: "https://production.plaid.com",
};

// Sandbox institution ("First Platypus Bank") that supports transactions.
const SANDBOX_INSTITUTION = "ins_109508";

function mapType(type: string, subtype: string | null): InternalAccountType {
  if (type === "credit") return "credit_card";
  if (type === "loan") return subtype === "mortgage" ? "mortgage" : "loan";
  if (type === "investment" || type === "brokerage") return "investment";
  if (type === "depository") return subtype === "savings" ? "savings" : "checking";
  return "other";
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
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Plaid ${path} → ${res.status}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  async connect(): Promise<ConnectResult> {
    const pub = await this.call<{ public_token: string }>("/sandbox/public_token/create", {
      institution_id: SANDBOX_INSTITUTION,
      initial_products: ["transactions"],
    });
    const exchanged = await this.call<{ access_token: string; item_id: string }>(
      "/item/public_token/exchange",
      { public_token: pub.public_token },
    );
    let institutionName = "Plaid";
    try {
      const inst = await this.call<{ institution: { name: string } }>("/institutions/get_by_id", {
        institution_id: SANDBOX_INSTITUTION,
        country_codes: ["US"],
      });
      institutionName = inst.institution.name;
    } catch {
      // Non-fatal — the connection still works without a pretty name.
    }
    return {
      externalItemId: exchanged.item_id,
      accessToken: exchanged.access_token,
      institutionName,
    };
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

  async syncTransactions(conn: ConnectionRef): Promise<BankTransactionData[]> {
    if (!conn.accessToken) throw new Error("Plaid connection is missing its access token");
    const out: BankTransactionData[] = [];
    let cursor: string | undefined;
    // /transactions/sync paginates and also blocks until the item's initial
    // pull is ready; cap the loop so a misbehaving item can't spin forever.
    for (let i = 0; i < 20; i++) {
      const page = await this.call<{
        added: Array<{
          transaction_id: string;
          account_id: string;
          date: string;
          amount: number;
          name: string;
          merchant_name: string | null;
        }>;
        has_more: boolean;
        next_cursor: string;
      }>("/transactions/sync", { access_token: conn.accessToken, ...(cursor ? { cursor } : {}) });

      for (const t of page.added) {
        out.push({
          externalId: t.transaction_id,
          externalAccountId: t.account_id,
          postedAt: t.date,
          // Plaid: positive amount = money out. App: negative = spending.
          amountCents: -Math.round(t.amount * 100),
          merchantName: t.merchant_name ?? t.name,
        });
      }
      cursor = page.next_cursor;
      if (!page.has_more) break;
    }
    return out;
  }
}
