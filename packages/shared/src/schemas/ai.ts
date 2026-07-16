import { z } from "zod";
import { AiConfigInput } from "./setup.js";

/** Settings + live reachability, shown on every AI-touching surface. */
export const AiStatus = z.object({
  enabled: z.boolean(),
  reachable: z.boolean(),
  host: z.string(),
  port: z.number().int(),
  model: z.string(),
  /** Model names Ollama reports as available (empty when unreachable). */
  availableModels: z.array(z.string()),
});
export type AiStatus = z.infer<typeof AiStatus>;

export const UpdateAiSettingsRequest = AiConfigInput;
export type UpdateAiSettingsRequest = z.infer<typeof UpdateAiSettingsRequest>;

export const AiMessage = z.object({
  id: z.string().uuid(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: z.string().datetime(),
});
export type AiMessage = z.infer<typeof AiMessage>;

export const Conversation = z.object({
  id: z.string().uuid(),
  title: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Conversation = z.infer<typeof Conversation>;

export const ConversationListResponse = z.object({
  conversations: z.array(Conversation),
});
export type ConversationListResponse = z.infer<typeof ConversationListResponse>;

export const ConversationDetail = Conversation.extend({
  messages: z.array(AiMessage),
});
export type ConversationDetail = z.infer<typeof ConversationDetail>;

export const ChatRequest = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().min(1).max(4000),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

/**
 * One NDJSON line of the chat stream (ADR-0005):
 *   { token }                          — next piece of assistant text
 *   { done: true, conversationId }     — final line, stream complete
 *   { error: { code, message } }       — terminal failure mid-stream
 */
export const ChatStreamLine = z.union([
  z.object({ token: z.string() }),
  z.object({ done: z.literal(true), conversationId: z.string().uuid() }),
  z.object({ error: z.object({ code: z.string(), message: z.string() }) }),
]);
export type ChatStreamLine = z.infer<typeof ChatStreamLine>;
