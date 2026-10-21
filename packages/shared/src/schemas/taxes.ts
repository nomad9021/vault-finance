import { z } from "zod";
import type { TaxEstimate } from "../tax/engine.js";

/**
 * The household's tax profile: who earns what (gross), how they're paid,
 * what comes out pre-tax, and where they live. The take-home estimate comes
 * from the shared tax engine (src/tax); with syncPlannedIncome on, the
 * budget planner's income follows the estimate.
 */

export const FilingStatusSchema = z.enum(["single", "married_joint", "married_separate", "head_of_household"]);
export const PayFrequencySchema = z.enum(["weekly", "biweekly", "semimonthly", "monthly"]);
const Cents = z.number().int().min(0).max(100_000_000_00);

export const TaxEarner = z.object({
  name: z.string().trim().min(1).max(60),
  grossAnnualCents: Cents,
  payFrequency: PayFrequencySchema.default("biweekly"),
  retirementPct: z.number().min(0).max(100).nullish(),
  retirementCents: Cents.nullish(),
  hsaCents: Cents.nullish(),
  healthPremiumCents: Cents.nullish(),
  otherPretaxCents: Cents.nullish(),
});
export type TaxEarner = z.infer<typeof TaxEarner>;

export const TaxProfile = z.object({
  filingStatus: FilingStatusSchema,
  state: z.string().regex(/^[A-Za-z]{2}$/).transform((s) => s.toUpperCase()),
  locality: z.string().max(40).nullish(),
  customLocalRatePct: z.number().min(0).max(10).nullish(),
  otherPayrollPct: z.number().min(0).max(5).nullish(),
  dependents: z.number().int().min(0).max(20).default(0),
  earners: z.array(TaxEarner).max(6),
  /** Keep the budget planner's monthly income equal to the estimated take-home. */
  syncPlannedIncome: z.boolean().default(true),
});
export type TaxProfile = z.infer<typeof TaxProfile>;
export type TaxProfileInput = z.input<typeof TaxProfile>;

/** The estimate comes from the shared engine, so the type is trusted rather than re-validated. */
export const TaxEstimateSchema = z.custom<TaxEstimate>((v) => typeof v === "object" && v !== null && "takeHomeCents" in v);

export const TaxProfileResponse = z.object({
  year: z.number().int(),
  profile: TaxProfile.nullable(),
  estimate: TaxEstimateSchema.nullable(),
});
export type TaxProfileResponse = z.infer<typeof TaxProfileResponse>;

export const TaxPlacesResponse = z.object({
  year: z.number().int(),
  states: z.array(z.object({ code: z.string(), name: z.string(), taxesWages: z.boolean() })),
  localities: z.array(z.object({ id: z.string(), state: z.string(), name: z.string(), verified: z.boolean() })),
});
export type TaxPlacesResponse = z.infer<typeof TaxPlacesResponse>;
