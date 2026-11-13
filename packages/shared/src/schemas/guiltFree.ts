import { z } from "zod";
import { WeekStart } from "./budgets.js";

/**
 * Guilt-free spending: each person in the household gets a weekly amount to
 * spend on anything, no questions asked. It's an ordinary category per person
 * (under one "Guilt-free spending" parent) with a weekly budget, so it resets
 * every week and shows on the actual, planned and budget-vs-actual Sankeys
 * like any other category. Purchases are ordinary transactions in it.
 */

const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const GuiltFreePurchase = z.object({
  /** The transaction's id. */
  id: z.string().uuid(),
  merchantName: z.string(),
  /** What was spent, as a positive number (a refund is negative). */
  amountCents: z.number().int(),
  postedAt: Ymd,
  /** Entered by hand (not from a bank or an import), so removing it deletes it. */
  manual: z.boolean(),
});
export type GuiltFreePurchase = z.infer<typeof GuiltFreePurchase>;

export const GuiltFreePerson = z.object({
  userId: z.string().uuid(),
  displayName: z.string(),
  avatarColor: z.string(),
  avatarImage: z.string().nullish(),
  /** The person signed in. */
  isMe: z.boolean(),
  /** Their guilt-free category; null until it's been set up for them. */
  categoryId: z.string().uuid().nullable(),
  /** The weekly amount; 0 when none is set. */
  weeklyCents: z.number().int().nonnegative(),
  /** Spent this week (purchases minus refunds). */
  spentCents: z.number().int(),
  /** This week's purchases, newest first. */
  purchases: z.array(GuiltFreePurchase),
});
export type GuiltFreePerson = z.infer<typeof GuiltFreePerson>;

export const GuiltFreeResponse = z.object({
  /** The "Guilt-free spending" parent category, once set up. */
  categoryId: z.string().uuid().nullable(),
  /** This week: its first day and the day after its last. */
  weekStart: Ymd,
  weekEnd: Ymd,
  people: z.array(GuiltFreePerson),
});
export type GuiltFreeResponse = z.infer<typeof GuiltFreeResponse>;

export const GuiltFreeQuery = z.object({ weekStart: WeekStart.optional() });
export type GuiltFreeQuery = z.infer<typeof GuiltFreeQuery>;

/** Set weekly amounts; people left out keep theirs. 0 removes the allowance. */
export const UpdateGuiltFreeRequest = z.object({
  people: z
    .array(z.object({ userId: z.string().uuid(), weeklyCents: z.number().int().min(0).max(100_000_00) }))
    .min(1)
    .max(20),
});
export type UpdateGuiltFreeRequest = z.infer<typeof UpdateGuiltFreeRequest>;
