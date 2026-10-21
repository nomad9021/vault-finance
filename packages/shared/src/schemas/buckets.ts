import { z } from "zod";

/** A named part of an account's balance (see the server's savings_buckets). */
export const Bucket = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  name: z.string(),
  color: z.string(),
  allocatedCents: z.number().int(),
  targetCents: z.number().int().nullable(),
  goalId: z.string().uuid().nullable(),
  sortOrder: z.number().int(),
});
export type Bucket = z.infer<typeof Bucket>;

/** One account with its buckets and what's left unassigned. */
export const BucketAccount = z.object({
  accountId: z.string().uuid(),
  accountName: z.string(),
  accountType: z.string(),
  balanceCents: z.number().int(),
  allocatedCents: z.number().int(),
  /** balance − allocated; negative when the buckets add up to more than the balance. */
  unassignedCents: z.number().int(),
  buckets: z.array(Bucket),
});
export type BucketAccount = z.infer<typeof BucketAccount>;

export const BucketListResponse = z.object({ accounts: z.array(BucketAccount) });
export type BucketListResponse = z.infer<typeof BucketListResponse>;

const Cents = z.number().int().min(0).max(100_000_000_00);
const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const CreateBucketRequest = z.object({
  accountId: z.string().uuid(),
  name: z.string().trim().min(1).max(60),
  allocatedCents: Cents.default(0),
  targetCents: Cents.nullish(),
  goalId: z.string().uuid().nullish(),
  color: Color.optional(),
});
export type CreateBucketRequest = z.input<typeof CreateBucketRequest>;

export const UpdateBucketRequest = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  allocatedCents: Cents.optional(),
  targetCents: Cents.nullish(),
  goalId: z.string().uuid().nullish(),
  color: Color.optional(),
  sortOrder: z.number().int().optional(),
});
export type UpdateBucketRequest = z.infer<typeof UpdateBucketRequest>;

/** Move money between two buckets of one account (null = unassigned). */
export const MoveBucketMoneyRequest = z.object({
  fromBucketId: z.string().uuid().nullable(),
  toBucketId: z.string().uuid().nullable(),
  amountCents: z.number().int().positive().max(100_000_000_00),
});
export type MoveBucketMoneyRequest = z.infer<typeof MoveBucketMoneyRequest>;
