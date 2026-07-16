import { z } from "zod";

export const Goal = z.object({
  id: z.string().uuid(),
  name: z.string(),
  targetCents: z.number().int(),
  /** Linked-account balance when linked; manual amount otherwise. */
  savedCents: z.number().int(),
  linkedAccountId: z.string().uuid().nullable(),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  color: z.string(),
  note: z.string().nullable(),
  /**
   * "YYYY-MM" the goal is projected to complete, from the linked account's
   * average net inflow over the last 90 days. Null when unlinked, funded,
   * or the account isn't growing.
   */
  projectedCompletion: z.string().regex(/^\d{4}-\d{2}$/).nullable(),
});
export type Goal = z.infer<typeof Goal>;

export const CreateGoalRequest = z.object({
  name: z.string().min(1).max(100),
  targetCents: z.number().int().positive(),
  savedCents: z.number().int().nonnegative().default(0),
  linkedAccountId: z.string().uuid().nullish(),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  note: z.string().max(500).nullish(),
});
export type CreateGoalRequest = z.infer<typeof CreateGoalRequest>;

export const UpdateGoalRequest = CreateGoalRequest.partial();
export type UpdateGoalRequest = z.infer<typeof UpdateGoalRequest>;

export const GoalListResponse = z.object({
  goals: z.array(Goal),
});
export type GoalListResponse = z.infer<typeof GoalListResponse>;
