import { z } from "zod";

export const AccountType = z.enum([
  "checking",
  "savings",
  "credit_card",
  "investment",
  "loan",
  "mortgage",
  "other",
]);
export type AccountType = z.infer<typeof AccountType>;

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  checking: "Checking",
  savings: "Savings",
  credit_card: "Credit card",
  investment: "Investment",
  loan: "Loan",
  mortgage: "Mortgage",
  other: "Other",
};

/** Types whose balance counts against net worth. */
export const LIABILITY_TYPES: ReadonlySet<AccountType> = new Set([
  "credit_card",
  "loan",
  "mortgage",
]);

export const Account = z.object({
  id: z.string().uuid(),
  name: z.string(),
  type: AccountType,
  institution: z.string().nullable(),
  mask: z.string().nullable(),
  currency: z.string(),
  isLiability: z.boolean(),
  interestRate: z.string().nullable(),
  balanceCents: z.number().int(),
  archivedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Account = z.infer<typeof Account>;

export const CreateAccountRequest = z.object({
  name: z.string().min(1).max(100),
  type: AccountType,
  institution: z.string().max(100).nullish(),
  mask: z.string().max(8).nullish(),
  balanceCents: z.number().int().default(0),
  interestRate: z.string().regex(/^\d{1,2}(\.\d{1,4})?$/).nullish(),
});
export type CreateAccountRequest = z.infer<typeof CreateAccountRequest>;

export const UpdateAccountRequest = CreateAccountRequest.partial().extend({
  archived: z.boolean().optional(),
});
export type UpdateAccountRequest = z.infer<typeof UpdateAccountRequest>;

export const AccountListResponse = z.object({
  accounts: z.array(Account),
});
export type AccountListResponse = z.infer<typeof AccountListResponse>;
