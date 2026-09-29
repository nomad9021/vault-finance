import { z } from "zod";

export const SetupStatusResponse = z.object({
  needsSetup: z.boolean(),
});
export type SetupStatusResponse = z.infer<typeof SetupStatusResponse>;

/**
 * First-run setup no longer configures AI — the assistant is off by default
 * and configured later in Settings (see schemas/ai.ts). This keeps the wizard
 * to a single step and the app AI-free out of the box.
 */
export const SetupCompleteRequest = z.object({
  ownerEmail: z.string().email(),
  ownerPassword: z.string().min(10).max(200),
  ownerDisplayName: z.string().min(1).max(100),
  /** Optional — the owner can set or rename it later in Settings. */
  householdName: z.string().trim().min(1).max(60).optional(),
});
export type SetupCompleteRequest = z.infer<typeof SetupCompleteRequest>;
