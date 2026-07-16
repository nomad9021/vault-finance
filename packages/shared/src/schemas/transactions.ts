import { z } from "zod";

/**
 * Sign convention (single source of truth for every module):
 * amountCents < 0 is money out (spending), > 0 is money in (income).
 */
export const Transaction = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  categoryId: z.string().uuid().nullable(),
  postedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountCents: z.number().int(),
  currency: z.string(),
  merchantName: z.string(),
  description: z.string().nullable(),
  pending: z.boolean(),
  notes: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type Transaction = z.infer<typeof Transaction>;

export const CreateTransactionRequest = z.object({
  accountId: z.string().uuid(),
  categoryId: z.string().uuid().nullish(),
  postedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountCents: z.number().int().refine((v) => v !== 0, "Amount cannot be zero"),
  merchantName: z.string().min(1).max(200),
  description: z.string().max(500).nullish(),
  pending: z.boolean().default(false),
  notes: z.string().max(2000).nullish(),
});
export type CreateTransactionRequest = z.infer<typeof CreateTransactionRequest>;

export const UpdateTransactionRequest = CreateTransactionRequest.omit({
  accountId: true,
}).partial();
export type UpdateTransactionRequest = z.infer<typeof UpdateTransactionRequest>;

export const TransactionListQuery = z.object({
  accountId: z.string().uuid().optional(),
  /** A category id, or the literal "none" for uncategorized transactions. */
  categoryId: z.union([z.literal("none"), z.string().uuid()]).optional(),
  search: z.string().max(200).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type TransactionListQuery = z.infer<typeof TransactionListQuery>;

export const TransactionListResponse = z.object({
  transactions: z.array(Transaction),
  nextCursor: z.string().nullable(),
  /** Total matching the filters (for the "n transactions" summary line). */
  totalCount: z.number().int(),
});
export type TransactionListResponse = z.infer<typeof TransactionListResponse>;

export const ImportResponse = z.object({
  imported: z.number().int(),
  skippedDuplicates: z.number().int(),
  errors: z.array(z.object({ line: z.number().int(), message: z.string() })),
});
export type ImportResponse = z.infer<typeof ImportResponse>;
