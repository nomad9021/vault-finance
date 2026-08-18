import { z } from "zod";

/**
 * A recurring charge detected from transaction history — nothing the user typed.
 * The server groups spending by merchant, looks for a regular interval between
 * charges, and reports what it found. Detection is a guess, so every field the
 * UI needs to justify the guess (how many hits, how regular, when it last
 * charged) is returned alongside it.
 */
export const SubscriptionCadence = z.enum(["weekly", "monthly", "quarterly", "yearly"]);
export type SubscriptionCadence = z.infer<typeof SubscriptionCadence>;

export const Subscription = z.object({
  /** Stable id derived from the merchant name, so the UI can key on it. */
  id: z.string(),
  merchantName: z.string(),
  /** Most recent charge amount. */
  amountCents: z.number().int(),
  /** Typical charge amount (median), normalized to a monthly equivalent. */
  monthlyCents: z.number().int(),
  cadence: SubscriptionCadence,
  /** How many charges the detection is based on. */
  occurrences: z.number().int(),
  lastChargedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Projected next charge from the last one plus the detected interval. */
  nextExpectedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  categoryId: z.string().uuid().nullable(),
  accountId: z.string().uuid().nullable(),
  /** 0–1: how regular the intervals are. Higher means a safer bet. */
  confidence: z.number(),
  /** Latest amount minus the previous one, when it went up. Null otherwise. */
  priceIncreaseCents: z.number().int().nullable(),
  /** True when the next charge is already overdue — possibly cancelled. */
  stale: z.boolean(),
  /** Set when a tracked bill already covers this merchant. */
  billId: z.string().uuid().nullable(),
});
export type Subscription = z.infer<typeof Subscription>;

export const SubscriptionListResponse = z.object({
  subscriptions: z.array(Subscription),
  /** Monthly-equivalent total across every detected subscription. */
  monthlyTotalCents: z.number().int(),
  yearlyTotalCents: z.number().int(),
});
export type SubscriptionListResponse = z.infer<typeof SubscriptionListResponse>;
