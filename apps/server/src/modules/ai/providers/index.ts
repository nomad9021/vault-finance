import type { AiProvider } from "@vault/shared";
import { anthropicProvider } from "./anthropic.js";
import { localOpenAiProvider, openaiProvider } from "./openai.js";
import { ollamaProvider } from "./ollama.js";
import type { ProviderClient } from "./types.js";

export type { AiConfig, ChatMessage, ProviderClient } from "./types.js";
export { isConfigured } from "./types.js";
export { describeAiError } from "./diagnose.js";

const PROVIDERS: Record<AiProvider, ProviderClient> = {
  ollama: ollamaProvider,
  local_openai: localOpenAiProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
};

export function getProvider(provider: AiProvider): ProviderClient {
  return PROVIDERS[provider];
}
