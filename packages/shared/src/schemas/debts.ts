import { z } from "zod";

export const DebtStrategy = z.enum(["avalanche", "snowball"]);
export type DebtStrategy = z.infer<typeof DebtStrategy>;

/** Per-account tweaks applied on top of a liability account in the planner. */
export const DebtOverride = z.object({
  name: z.string().optional(),
  balanceCents: z.number().int().optional(),
  apr: z.number().optional(),
  minCents: z.number().int().optional(),
});
export type DebtOverride = z.infer<typeof DebtOverride>;

/** A debt the user typed in that isn't backed by a liability account. */
export const ManualDebt = z.object({
  id: z.string(),
  name: z.string(),
  balanceCents: z.number().int(),
  apr: z.number(),
  minCents: z.number().int(),
});
export type ManualDebt = z.infer<typeof ManualDebt>;

/** Persisted "Get out of debt" planner state (a single shared record). */
export const DebtPlan = z.object({
  extraCents: z.number().int().nonnegative(),
  strategy: DebtStrategy,
  /** Keyed by liability accountId. */
  overrides: z.record(z.string(), DebtOverride),
  manual: z.array(ManualDebt),
});
export type DebtPlan = z.infer<typeof DebtPlan>;

export const UpdateDebtPlanRequest = DebtPlan;
export type UpdateDebtPlanRequest = z.infer<typeof UpdateDebtPlanRequest>;
