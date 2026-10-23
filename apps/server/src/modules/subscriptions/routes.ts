import type {
  Subscription as ApiSubscription,
  SubscriptionCadence,
  SubscriptionListResponse,
} from "@vault/shared";
import { and, eq, gte, isNull, lt, notInArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { accounts, bills, subscriptionDismissals, transactions } from "../../db/schema.js";
import { billMatchesMerchant, normalizeMerchant } from "./merchant.js";

/**
 * Recurring-charge detection over transaction history.
 *
 * Nothing here is user-entered: the household already has the evidence in its
 * ledger, so asking someone to re-type their subscriptions would be busywork.
 * The trade-off is that detection is a guess, so every result carries the
 * evidence behind it (occurrence count, regularity) and the UI is expected to
 * present these as candidates, not facts.
 *
 * Two kinds of result are taken out of the list and its totals: charges the
 * household marked "not a subscription" (returned separately so it can be
 * undone), and charges a tracked bill already covers — counting those here too
 * would show the same money twice.
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
    const dismissedKeys = new Set(
      (await app.db.select().from(subscriptionDismissals)).map((d) => d.merchantKey),
    );
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

      const bill = billRows.find((b) => billMatchesMerchant(b.name, key));

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
    const dismissed = found.filter((s) => dismissedKeys.has(s.id));
    const trackedAsBillCount = found.filter((s) => !dismissedKeys.has(s.id) && s.billId).length;
    const subscriptions = found.filter((s) => !dismissedKeys.has(s.id) && !s.billId);
    const monthlyTotalCents = subscriptions
      .filter((s) => !s.stale)
      .reduce((sum, s) => sum + s.monthlyCents, 0);
    return {
      subscriptions,
      dismissed,
      trackedAsBillCount,
      monthlyTotalCents,
      yearlyTotalCents: monthlyTotalCents * 12,
    };
  });

  // "Not a subscription". The id is the detection key (merchant name, normalized
  // and hyphenated), so the dismissal also covers future charges from it.
  app.post<{ Params: { id: string } }>("/subscriptions/:id/dismiss", async (request, reply) => {
    const { merchantName } = z.object({ merchantName: z.string().min(1).max(200) }).parse(request.body);
    const merchantKey = z.string().min(1).max(200).parse(request.params.id);
    await app.db
      .insert(subscriptionDismissals)
      .values({ merchantKey, merchantName })
      .onConflictDoNothing();
    return reply.status(204).send();
  });

  app.delete<{ Params: { id: string } }>("/subscriptions/:id/dismiss", async (request, reply) => {
    await app.db
      .delete(subscriptionDismissals)
      .where(eq(subscriptionDismissals.merchantKey, request.params.id));
    return reply.status(204).send();
  });
}
