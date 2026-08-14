import { z } from "zod";

/**
 * Two shapes of money that leaves the household on purpose.
 *
 * "giving" is a recurring outflow — a tithe, a sponsored child, a monthly
 * donation. It has no end state, so it has no target.
 * "gift" is a sinking fund: save a bit each month toward a birthday, a wedding,
 * Christmas, then spend it and start again. It has a target and a date.
 *
 * They share a table (and a Sankey branch) because from the cash-flow side they
 * are the same thing: planned money going out that isn't spending on ourselves.
 */
export const GivingKind = z.enum(["giving", "gift"]);
export type GivingKind = z.infer<typeof GivingKind>;

export const GivingFund = z.object({
  id: z.string().uuid(),
  name: z.string(),
  kind: GivingKind,
  recipient: z.string().nullable(),
  /** Planned monthly outflow — what the Sankey routes into this fund. */
  monthlyCents: z.number().int(),
  /** Set aside so far; follows the linked account's balance when linked. */
  savedCents: z.number().int(),
  /** Gift funds save toward this; null for open-ended giving. */
  targetCents: z.number().int().nullable(),
  occasionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  accountId: z.string().uuid().nullable(),
  categoryId: z.string().uuid().nullable(),
  color: z.string(),
  note: z.string().nullable(),
  /** Server-computed: whole days until occasionDate, null when there isn't one. */
  daysUntilOccasion: z.number().int().nullable(),
  /**
   * Server-computed: what you'd need to set aside each month to hit the target
   * by the occasion date. Null unless the fund has both, or when already funded.
   */
  neededMonthlyCents: z.number().int().nullable(),
  /** Server-computed: given to this fund in the last 12 months, from transactions. */
  givenThisYearCents: z.number().int(),
});
export type GivingFund = z.infer<typeof GivingFund>;

export const CreateGivingFundRequest = z.object({
  name: z.string().min(1).max(80),
  kind: GivingKind.default("giving"),
  recipient: z.string().max(120).nullish(),
  monthlyCents: z.number().int().nonnegative().default(0),
  savedCents: z.number().int().nonnegative().optional(),
  targetCents: z.number().int().positive().nullish(),
  occasionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  accountId: z.string().uuid().nullish(),
  categoryId: z.string().uuid().nullish(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  note: z.string().max(500).nullish(),
});
export type CreateGivingFundRequest = z.infer<typeof CreateGivingFundRequest>;

export const UpdateGivingFundRequest = CreateGivingFundRequest.partial();
export type UpdateGivingFundRequest = z.infer<typeof UpdateGivingFundRequest>;

/** Add to (or subtract from) what a fund has set aside. */
export const ContributeGivingRequest = z.object({
  deltaCents: z.number().int(),
});
export type ContributeGivingRequest = z.infer<typeof ContributeGivingRequest>;

export const GivingListResponse = z.object({
  funds: z.array(GivingFund),
  /** Sum of monthlyCents across recurring giving funds. */
  monthlyGivingCents: z.number().int(),
  /** Sum of monthlyCents across gift sinking funds. */
  monthlyGiftCents: z.number().int(),
  /** Set aside across every fund. */
  totalSavedCents: z.number().int(),
  /** Actually given over the last 12 months, from categorized transactions. */
  givenThisYearCents: z.number().int(),
});
export type GivingListResponse = z.infer<typeof GivingListResponse>;
