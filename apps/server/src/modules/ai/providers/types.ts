import type { AiProvider } from "@vault/shared";

/** Resolved AI configuration (from ai_settings) passed to a provider client. */
export interface AiConfig {
  provider: AiProvider;
  model: string;
  apiKey: string | null;
  baseUrl: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Uniform interface every provider client implements. The server proxies to
 * whichever provider is configured (ADR-0005), so the routes never branch on
 * provider — they call these three methods.
 */
export interface ProviderClient {
  /**
   * Reachability + credential check. Returns the provider's available model
   * list (Ollama's installed models; a bounded id list for cloud). Throws if
   * unreachable or the key is rejected — callers turn that into AI_UNAVAILABLE.
   */
  listModels(config: AiConfig): Promise<string[]>;

  /** Stream a chat completion, calling onToken per text fragment. */
  streamChat(
    config: AiConfig,
    messages: ChatMessage[],
    onToken: (token: string) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<void>;

  /** One-shot completion — used for cached monthly-report commentary. */
  generateText(config: AiConfig, prompt: string): Promise<string>;
}

/** True when the config has the credentials its provider requires. */
export function isConfigured(config: {
  provider: AiProvider;
  apiKey: string | null;
  baseUrl: string;
}): boolean {
  if (config.provider === "ollama") return config.baseUrl.trim().length > 0;
  return (config.apiKey?.trim().length ?? 0) > 0;
}
