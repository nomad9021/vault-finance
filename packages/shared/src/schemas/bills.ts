import { z } from "zod";

export const BillCadence = z.enum(["weekly", "monthly", "quarterly", "yearly"]);
export type BillCadence = z.infer<typeof BillCadence>;

export const Bill = z.object({
  id: z.string().uuid(),
  name: z.string(),
  amountCents: z.number().int(),
  savedCents: z.number().int(),
  dueDay: z.number().int().min(1).max(31),
  cadence: BillCadence,
  autopay: z.boolean(),
  accountId: z.string().uuid().nullable(),
  categoryId: z.string().uuid().nullable(),
  color: z.string(),
  /** Server-computed: the next occurrence date (YYYY-MM-DD) from today. */
  nextDueDate: z.string(),
  /** Server-computed: whole days until nextDueDate (negative if overdue today). */
  daysUntilDue: z.number().int(),
});
export type Bill = z.infer<typeof Bill>;

export const CreateBillRequest = z.object({
  name: z.string().min(1).max(80),
  amountCents: z.number().int().positive(),
  savedCents: z.number().int().min(0).optional(),
  dueDay: z.number().int().min(1).max(31),
  cadence: BillCadence.default("monthly"),
  autopay: z.boolean().optional(),
  accountId: z.string().uuid().nullish(),
  categoryId: z.string().uuid().nullish(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});
export type CreateBillRequest = z.infer<typeof CreateBillRequest>;

export const UpdateBillRequest = CreateBillRequest.partial();
export type UpdateBillRequest = z.infer<typeof UpdateBillRequest>;

/** Add (or subtract, if negative) an amount from a bill's set-aside savings. */
export const ContributeBillRequest = z.object({
  deltaCents: z.number().int(),
});
export type ContributeBillRequest = z.infer<typeof ContributeBillRequest>;

export const BillListResponse = z.object({
  bills: z.array(Bill),
  totalDueCents: z.number().int(),
  totalSavedCents: z.number().int(),
});
export type BillListResponse = z.infer<typeof BillListResponse>;
