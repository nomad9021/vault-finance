import type { AiProvider } from "@vault/shared";
import { anthropicProvider } from "./anthropic.js";
import { openaiProvider } from "./openai.js";
import { ollamaProvider } from "./ollama.js";
import type { ProviderClient } from "./types.js";

export type { AiConfig, ChatMessage, ProviderClient } from "./types.js";
export { isConfigured } from "./types.js";

const PROVIDERS: Record<AiProvider, ProviderClient> = {
  ollama: ollamaProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
};

export function getProvider(provider: AiProvider): ProviderClient {
  return PROVIDERS[provider];
}
