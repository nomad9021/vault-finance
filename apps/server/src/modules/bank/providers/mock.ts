import { randomUUID } from "node:crypto";
import type {
  BankAccountData,
  BankProviderClient,
  BankTransactionData,
  ConnectResult,
  ConnectionRef,
} from "./types.js";

/**
 * Fully local fake bank. Fabricates a stable set of accounts and ~8 weeks of
 * transactions keyed off the connection's item id, so repeated syncs are
 * idempotent (same externalIds → import dedupe skips them). Nothing leaves the
 * server; this is what makes the prototype demoable without any Plaid signup.
 */

const MERCHANTS: Array<{ name: string; cents: number; acct: "checking" | "card" }> = [
  { name: "Fresh Market", cents: -4210, acct: "checking" },
  { name: "Corner Grocer", cents: -2685, acct: "checking" },
  { name: "Starbeans & Vine", cents: -1240, acct: "card" },
  { name: "Noodle House", cents: -1890, acct: "card" },
  { name: "City Power & Light", cents: -9800, acct: "checking" },
  { name: "Metro Internet", cents: -6500, acct: "checking" },
  { name: "Gas & Go", cents: -5230, acct: "card" },
  { name: "Big Box Store", cents: -8875, acct: "card" },
  { name: "StreamFlix", cents: -1599, acct: "checking" },
  { name: "Acme Payroll", cents: 512000, acct: "checking" },
];

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export class MockBankProvider implements BankProviderClient {
  async connect(): Promise<ConnectResult> {
    return {
      externalItemId: `mock-${randomUUID()}`,
      accessToken: null,
      institutionName: "Sandbox Bank (local demo)",
    };
  }

  async listAccounts(conn: ConnectionRef): Promise<BankAccountData[]> {
    const base = conn.externalItemId;
    return [
      {
        externalAccountId: `${base}:checking`,
        name: "Sandbox Checking",
        type: "checking",
        mask: "0000",
        balanceCents: 348_000,
        currency: "USD",
      },
      {
        externalAccountId: `${base}:savings`,
        name: "Sandbox Savings",
        type: "savings",
        mask: "1111",
        balanceCents: 1_120_000,
        currency: "USD",
      },
      {
        externalAccountId: `${base}:card`,
        name: "Sandbox Credit Card",
        type: "credit_card",
        mask: "2222",
        balanceCents: -42_300,
        currency: "USD",
      },
    ];
  }

  async syncTransactions(conn: ConnectionRef): Promise<BankTransactionData[]> {
    const base = conn.externalItemId;
    const out: BankTransactionData[] = [];
    // Eight weekly cycles of the merchant set, most-recent first.
    for (let week = 0; week < 8; week++) {
      const day = new Date();
      day.setUTCDate(day.getUTCDate() - week * 7);
      for (let i = 0; i < MERCHANTS.length; i++) {
        const m = MERCHANTS[i]!;
        out.push({
          externalId: `${base}:txn:${week}:${i}`,
          externalAccountId: `${base}:${m.acct}`,
          postedAt: ymd(day),
          amountCents: m.cents,
          merchantName: m.name,
        });
      }
    }
    return out;
  }
}
