import { z } from "zod";

export const SetupStatusResponse = z.object({
  needsSetup: z.boolean(),
});
export type SetupStatusResponse = z.infer<typeof SetupStatusResponse>;

export const AiConfigInput = z.object({
  ollamaHost: z.string().min(1),
  ollamaPort: z.number().int().min(1).max(65535),
  modelName: z.string().min(1),
  enabled: z.boolean(),
});
export type AiConfigInput = z.infer<typeof AiConfigInput>;

export const SetupCompleteRequest = z.object({
  ownerEmail: z.string().email(),
  ownerPassword: z.string().min(10).max(200),
  ownerDisplayName: z.string().min(1).max(100),
  aiConfig: AiConfigInput.optional(),
});
export type SetupCompleteRequest = z.infer<typeof SetupCompleteRequest>;
