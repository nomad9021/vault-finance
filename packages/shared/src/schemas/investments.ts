import { z } from "zod";

export const Holding = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  symbol: z.string(),
  name: z.string().nullable(),
  quantity: z.string(),
  costBasisCents: z.number().int().nullable(),
  /** User-maintained — no market-data feeds in a privacy-first app. */
  marketValueCents: z.number().int(),
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type Holding = z.infer<typeof Holding>;

export const CreateHoldingRequest = z.object({
  symbol: z.string().min(1).max(20),
  name: z.string().max(100).nullish(),
  quantity: z.string().regex(/^\d+(\.\d{1,6})?$/),
  costBasisCents: z.number().int().nullish(),
  marketValueCents: z.number().int().nonnegative(),
});
export type CreateHoldingRequest = z.infer<typeof CreateHoldingRequest>;

export const UpdateHoldingRequest = CreateHoldingRequest.partial();
export type UpdateHoldingRequest = z.infer<typeof UpdateHoldingRequest>;

export const InvestmentAccount = z.object({
  id: z.string().uuid(),
  name: z.string(),
  institution: z.string().nullable(),
  /** Sum of holdings' market values (account.balanceCents stays user-set). */
  holdingsValueCents: z.number().int(),
  costBasisCents: z.number().int(),
  holdings: z.array(Holding),
});
export type InvestmentAccount = z.infer<typeof InvestmentAccount>;

export const AllocationSlice = z.object({
  symbol: z.string(),
  name: z.string().nullable(),
  valueCents: z.number().int(),
  /** 0–1 share of total holdings value. */
  share: z.number(),
});
export type AllocationSlice = z.infer<typeof AllocationSlice>;

export const InvestmentsResponse = z.object({
  accounts: z.array(InvestmentAccount),
  totalValueCents: z.number().int(),
  totalCostBasisCents: z.number().int(),
  allocation: z.array(AllocationSlice),
});
export type InvestmentsResponse = z.infer<typeof InvestmentsResponse>;
