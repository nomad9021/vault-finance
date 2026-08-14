import type {
  Subscription as ApiSubscription,
  SubscriptionCadence,
  SubscriptionListResponse,
} from "@vault/shared";
import { and, gte, isNull, lt, notInArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { accounts, bills, transactions } from "../../db/schema.js";

/**
 * Recurring-charge detection over transaction history.
 *
 * Nothing here is user-entered: the household already has the evidence in its
 * ledger, so asking someone to re-type their subscriptions would be busywork.
 * The trade-off is that detection is a guess, so every result carries the
 * evidence behind it (occurrence count, regularity) and the UI is expected to
 * present these as candidates, not facts.
 */

/** Charges closer together than this are one purchase, not two occurrences. */
const SAME_CHARGE_DAYS = 2;
/** Fewer hits than this is a coincidence, not a pattern. */
const MIN_OCCURRENCES = 3;
/** How far back to look. 13 months so a yearly charge can be seen twice. */
const LOOKBACK_DAYS = 400;

interface Bucket {
  low: number;
  high: number;
  cadence: SubscriptionCadence;
  perMonth: number;
}
// Windows are generous because real billing drifts — weekends, month lengths,
// and "the 3rd business day" all move a charge by a few days.
const BUCKETS: Bucket[] = [
  { low: 5, high: 9, cadence: "weekly", perMonth: 52 / 12 },
  { low: 25, high: 36, cadence: "monthly", perMonth: 1 },
  { low: 80, high: 100, cadence: "quarterly", perMonth: 1 / 3 },
  { low: 350, high: 380, cadence: "yearly", perMonth: 1 / 12 },
];

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!;
}

function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

function dateFromDayNumber(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Merchant names arrive with transaction noise — store numbers, dates, card
 * suffixes. Normalizing lets "AMZN Mktp US*2K4L" and "AMZN Mktp US*9F1C" land in
 * the same bucket, which is the difference between spotting a subscription and
 * seeing thirty one-offs.
 */
function normalizeMerchant(name: string): string {
  return name
    .toLowerCase()
    .replace(/[*#]\w+/g, " ")
    .replace(/\b\d[\d-]*\b/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 0–1 regularity: how tightly the gaps cluster around their median. */
function regularity(intervals: number[], med: number): number {
  if (intervals.length === 0 || med <= 0) return 0;
  const meanAbsDev =
    intervals.reduce((s, i) => s + Math.abs(i - med), 0) / intervals.length;
  return Math.max(0, Math.min(1, 1 - meanAbsDev / med));
}

export default async function subscriptionRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireAuth);

  app.get("/subscriptions", async (): Promise<SubscriptionListResponse> => {
    const accts = await app.db.select().from(accounts);
    const archivedIds = accts.filter((a) => a.archivedAt).map((a) => a.id);
    const notArchived = archivedIds.length
      ? notInArray(transactions.accountId, archivedIds)
      : undefined;
    const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);

    const rows = await app.db
      .select({
        merchantName: transactions.merchantName,
        postedAt: transactions.postedAt,
        amountCents: transactions.amountCents,
        categoryId: transactions.categoryId,
        accountId: transactions.accountId,
      })
      .from(transactions)
      .where(
        and(gte(transactions.postedAt, cutoff), lt(transactions.amountCents, 0), notArchived),
      );

    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = normalizeMerchant(row.merchantName);
      if (!key) continue;
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }

    const billRows = await app.db.select().from(bills).where(isNull(bills.archivedAt));
    const today = dayNumber(new Date().toISOString().slice(0, 10));
    const found: ApiSubscription[] = [];

    for (const [key, list] of groups) {
      if (list.length < MIN_OCCURRENCES) continue;
      const sorted = [...list].sort((a, b) => a.postedAt.localeCompare(b.postedAt));

      // Collapse same-day/next-day duplicates into one occurrence, keeping the
      // largest amount — a split charge still bills once.
      const occurrences: { day: number; amount: number; row: (typeof sorted)[number] }[] = [];
      for (const row of sorted) {
        const day = dayNumber(row.postedAt);
        const amount = Math.abs(row.amountCents);
        const last = occurrences[occurrences.length - 1];
        if (last && day - last.day <= SAME_CHARGE_DAYS) {
          if (amount > last.amount) {
            last.amount = amount;
            last.row = row;
          }
          continue;
        }
        occurrences.push({ day, amount, row });
      }
      if (occurrences.length < MIN_OCCURRENCES) continue;

      const intervals: number[] = [];
      for (let i = 1; i < occurrences.length; i++) {
        intervals.push(occurrences[i]!.day - occurrences[i - 1]!.day);
      }
      const medInterval = median(intervals);
      const bucket = BUCKETS.find((b) => medInterval >= b.low && medInterval <= b.high);
      if (!bucket) continue;

      const confidence = regularity(intervals, medInterval);
      // Wildly irregular gaps that happen to average out to ~30 days are a
      // coincidence (groceries, fuel), not a subscription.
      if (confidence < 0.6) continue;

      const amounts = occurrences.map((o) => o.amount);
      const typical = median(amounts);
      const latest = occurrences[occurrences.length - 1]!;
      const previous = occurrences[occurrences.length - 2]!;
      const nextExpectedDay = latest.day + medInterval;

      const bill = billRows.find((b) => {
        const billKey = normalizeMerchant(b.name);
        return billKey.length > 2 && (billKey === key || key.includes(billKey) || billKey.includes(key));
      });

      found.push({
        id: key.replace(/\s+/g, "-"),
        merchantName: latest.row.merchantName,
        amountCents: latest.amount,
        monthlyCents: Math.round(typical * bucket.perMonth),
        cadence: bucket.cadence,
        occurrences: occurrences.length,
        lastChargedAt: dateFromDayNumber(latest.day),
        nextExpectedAt: dateFromDayNumber(nextExpectedDay),
        categoryId: latest.row.categoryId,
        accountId: latest.row.accountId,
        confidence: Math.round(confidence * 100) / 100,
        priceIncreaseCents: latest.amount > previous.amount ? latest.amount - previous.amount : null,
        // Half an interval past due: long enough to rule out normal drift, short
        // enough to still be worth telling someone about.
        stale: today > nextExpectedDay + medInterval / 2,
        billId: bill?.id ?? null,
      });
    }

    found.sort((a, b) => b.monthlyCents - a.monthlyCents);
    const monthlyTotalCents = found
      .filter((s) => !s.stale)
      .reduce((sum, s) => sum + s.monthlyCents, 0);
    return {
      subscriptions: found,
      monthlyTotalCents,
      yearlyTotalCents: monthlyTotalCents * 12,
    };
  });
}
