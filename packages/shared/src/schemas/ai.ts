import { z } from "zod";

/**
 * AI providers the assistant can use. The user brings their own credentials
 * for cloud providers; Ollama is local/self-hosted. AI is OFF by default —
 * nothing is sent anywhere until the owner enables and configures a provider.
 */
export const AiProvider = z.enum(["ollama", "local_openai", "openai", "anthropic"]);
export type AiProvider = z.infer<typeof AiProvider>;

export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  ollama: "Ollama (local)",
  local_openai: "Other local AI (OpenAI-compatible)",
  openai: "OpenAI",
  anthropic: "Anthropic (Claude)",
};

/**
 * Providers that run on hardware you control — the bundled Ollama container,
 * or a separate AI machine (a GPU desktop, another server) the Vault server
 * reaches over your LAN or Tailscale. They need a base URL; a key is optional
 * (only for a server behind an authenticating proxy).
 */
export const LOCAL_PROVIDERS: ReadonlySet<AiProvider> = new Set(["ollama", "local_openai"]);

/** Example base URLs shown as placeholders for the local providers. */
export const AI_BASE_URL_EXAMPLES: Partial<Record<AiProvider, string>> = {
  ollama: "http://ollama:11434",
  local_openai: "http://192.168.1.50:1234/v1",
};

/** Cloud providers send your financial context off your server under your key. */
export const CLOUD_PROVIDERS: ReadonlySet<AiProvider> = new Set([
  "openai",
  "anthropic",
]);

/** Suggested default model per provider (the owner can type any value). */
export const AI_MODEL_SUGGESTIONS: Record<AiProvider, string[]> = {
  ollama: ["llama3.1:8b", "llama3.2:3b", "qwen2.5:7b", "mistral:7b"],
  // Whatever the server has loaded — the list is discovered with "Test connection".
  local_openai: [],
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
  /** Base URL for a local provider (e.g. http://ollama:11434); empty for cloud providers. */
  baseUrl: z.string(),
  hasApiKey: z.boolean(),
  /** Models the provider reports (Ollama's installed list; cloud model IDs). */
  availableModels: z.array(z.string()),
  /** Quality-tier → model map the manager resolves against. */
  qualityModels: QualityModelMap,
  /** When true, UIs may show the model name next to the quality tier. */
  showModelNames: z.boolean(),
  /** Why the provider is unreachable, in plain words (absent when reachable). */
  error: z.string().optional(),
  /** What to try next for `error`. */
  hint: z.string().optional(),
});
export type AiStatus = z.infer<typeof AiStatus>;

/**
 * True for addresses that never leave your own networks: loopback, private
 * LAN ranges, Tailscale (100.64.0.0/10, *.ts.net — WireGuard-encrypted),
 * and single-label or .local/.lan/.internal names (Docker services, mDNS).
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h.includes(".") && !h.includes(":")) return true; // "ollama", "localhost"
  if (/\.(local|lan|home|internal|home\.arpa|ts\.net)$/.test(h)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  return h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
}

/** Financial context must never cross the internet unencrypted. */
export function plainHttpToPublicHost(baseUrl: string | undefined): boolean {
  const raw = baseUrl?.trim() ?? "";
  if (!/^http:\/\//i.test(raw)) return false;
  // No URL global in this package's lib; the host is between "://" and the next "/", "?" or "#".
  const authority = raw.slice(7).split(/[/?#]/)[0] ?? "";
  const host = authority.replace(/^[^@]*@/, "");
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.replace(/:\d*$/, "");
  return hostname !== "" && !isPrivateHost(hostname);
}
const PUBLIC_HTTP_MESSAGE =
  "An AI server on the internet must use https:// — plain http:// would send your financial data unencrypted. http:// is fine on your own network or Tailscale.";

/**
 * Try a provider configuration without saving it — powers "Test connection"
 * for a separate AI machine. Omit apiKey to reuse the stored key.
 */
export const AiTestRequest = z
  .object({
    provider: AiProvider,
    baseUrl: z.string().max(300).optional(),
    apiKey: z.string().max(400).optional(),
  })
  .refine((v) => !plainHttpToPublicHost(v.baseUrl), { message: PUBLIC_HTTP_MESSAGE, path: ["baseUrl"] });
export type AiTestRequest = z.infer<typeof AiTestRequest>;

export const AiTestResponse = z.object({
  ok: z.boolean(),
  /** Models the server reported (empty on failure). */
  models: z.array(z.string()),
  latencyMs: z.number().int(),
  error: z.string().optional(),
  hint: z.string().optional(),
});
export type AiTestResponse = z.infer<typeof AiTestResponse>;

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
     * API key (cloud), or an optional token for a local AI server behind an
     * authenticating proxy. Omit to keep the stored key unchanged; send an empty
     * string to clear it. Never returned by any endpoint.
     */
    apiKey: z.string().max(400).optional(),
    /** Local provider base URL, or an optional OpenAI endpoint override. */
    baseUrl: z.string().max(300).optional(),
    /** quality-tier → model map (local providers). Omit to leave unchanged. */
    qualityModels: QualityModelMap.optional(),
    /** Toggle showing model names beside quality tiers. Omit to leave unchanged. */
    showModelNames: z.boolean().optional(),
  })
  .refine((v) => !LOCAL_PROVIDERS.has(v.provider) || /^https?:\/\/\S+$/.test(v.baseUrl?.trim() ?? ""), {
    message: "A local AI server needs a base URL starting with http:// or https://, e.g. http://ollama:11434",
    path: ["baseUrl"],
  })
  .refine((v) => !plainHttpToPublicHost(v.baseUrl), { message: PUBLIC_HTTP_MESSAGE, path: ["baseUrl"] });
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
