import { z } from "zod";

/**
 * AI providers the assistant can use. The user brings their own credentials
 * for cloud providers; Ollama is local/self-hosted. AI is OFF by default —
 * nothing is sent anywhere until the owner enables and configures a provider.
 */
export const AiProvider = z.enum(["ollama", "openai", "anthropic"]);
export type AiProvider = z.infer<typeof AiProvider>;

export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  ollama: "Ollama (local)",
  openai: "OpenAI",
  anthropic: "Anthropic (Claude)",
};

/** Cloud providers send your financial context off your server under your key. */
export const CLOUD_PROVIDERS: ReadonlySet<AiProvider> = new Set([
  "openai",
  "anthropic",
]);

/** Suggested default model per provider (the owner can type any value). */
export const AI_MODEL_SUGGESTIONS: Record<AiProvider, string[]> = {
  ollama: ["llama3.1:8b", "llama3.2:3b", "qwen2.5:7b", "mistral:7b"],
  openai: ["gpt-4o-mini", "gpt-4o", "o4-mini"],
  anthropic: ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"],
};

/**
 * Quality tiers the app requests instead of naming a model directly. The AI
 * Model Manager maps each tier to an actual model, so the UI never has to show
 * model names (unless the user opts in) and new tiers/providers can be added
 * without touching call sites. Ordered low → high.
 */
export const AiQuality = z.enum(["low", "normal", "high", "ultra"]);
export type AiQuality = z.infer<typeof AiQuality>;
export const AI_QUALITY_LEVELS = AiQuality.options;
export const AI_QUALITY_LABELS: Record<AiQuality, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  ultra: "Ultra",
};
/** Which quality tier each AI feature asks for (tunable in one place). */
export const AI_FEATURE_QUALITY = {
  categorize: "normal",
  reports: "high",
  chat: "high",
} as const satisfies Record<string, AiQuality>;

/** quality-tier → model-name map (free-form so future tiers just work). */
export const QualityModelMap = z.record(z.string(), z.string());
export type QualityModelMap = z.infer<typeof QualityModelMap>;

/**
 * Live AI status, shown on every AI-touching surface. The API key itself is
 * never returned — only `hasApiKey`. `configured` means the provider has the
 * credentials it needs (a key for cloud, a base URL for Ollama).
 */
export const AiStatus = z.object({
  enabled: z.boolean(),
  configured: z.boolean(),
  reachable: z.boolean(),
  provider: AiProvider,
  model: z.string(),
  /** Ollama base URL (e.g. http://ollama:11434); empty for cloud providers. */
  baseUrl: z.string(),
  hasApiKey: z.boolean(),
  /** Models the provider reports (Ollama's installed list; cloud model IDs). */
  availableModels: z.array(z.string()),
  /** Quality-tier → model map the manager resolves against. */
  qualityModels: QualityModelMap,
  /** When true, UIs may show the model name next to the quality tier. */
  showModelNames: z.boolean(),
});
export type AiStatus = z.infer<typeof AiStatus>;

export const AiModelsResponse = z.object({
  /** Installed/available models, freshly probed from the provider. */
  models: z.array(z.string()),
});
export type AiModelsResponse = z.infer<typeof AiModelsResponse>;

export const UpdateAiSettingsRequest = z
  .object({
    enabled: z.boolean(),
    provider: AiProvider,
    model: z.string().min(1).max(100),
    /**
     * Cloud API key. Omit to keep the stored key unchanged; send an empty
     * string to clear it. Never returned by any endpoint.
     */
    apiKey: z.string().max(400).optional(),
    /** Ollama base URL, or an optional OpenAI-compatible endpoint override. */
    baseUrl: z.string().max(300).optional(),
    /** quality-tier → model map (Ollama). Omit to leave unchanged. */
    qualityModels: QualityModelMap.optional(),
    /** Toggle showing model names beside quality tiers. Omit to leave unchanged. */
    showModelNames: z.boolean().optional(),
  })
  .refine((v) => v.provider !== "ollama" || (v.baseUrl?.trim().length ?? 0) > 0, {
    message: "Ollama needs a base URL, e.g. http://ollama:11434",
    path: ["baseUrl"],
  });
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
