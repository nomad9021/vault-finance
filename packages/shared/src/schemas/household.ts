import { z } from "zod";

/**
 * The household is the server instance itself — everyone with a login on it
 * shares its accounts. Its name is separate from any member's name so the app
 * can say "The Carters" instead of whoever happened to create it.
 */
export const Household = z.object({
  name: z.string().nullable(),
});
export type Household = z.infer<typeof Household>;

export const UpdateHouseholdRequest = z.object({
  name: z.string().trim().min(1).max(60),
});
export type UpdateHouseholdRequest = z.infer<typeof UpdateHouseholdRequest>;
