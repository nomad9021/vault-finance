import OpenAI from "openai";
import type { AiConfig, ProviderClient } from "./types.js";

/**
 * OpenAI client via the official SDK. The user supplies their own API key;
 * baseUrl is an optional OpenAI-compatible endpoint override (blank → the
 * SDK's default https://api.openai.com/v1).
 */
function client(config: AiConfig): OpenAI {
  const override = config.baseUrl.trim();
  return new OpenAI({
    apiKey: config.apiKey ?? "",
    ...(/^https?:\/\//.test(override) ? { baseURL: override } : {}),
    maxRetries: 1,
  });
}

/**
 * A self-hosted OpenAI-compatible server on a separate machine — LM Studio,
 * llama.cpp's llama-server, vLLM, LocalAI, Jan, text-generation-webui, or
 * Ollama's own /v1 endpoint. Same wire protocol as OpenAI, but the base URL
 * is required (never falls back to api.openai.com, so a typo can't send your
 * data to the cloud) and the key is optional.
 */
function localClient(config: AiConfig): OpenAI {
  const base = config.baseUrl.trim();
  if (!/^https?:\/\//.test(base)) {
    throw new Error("local AI server needs a base URL starting with http:// or https://");
  }
  return new OpenAI({
    // Most local servers ignore the key; the SDK just needs a non-empty value.
    apiKey: config.apiKey?.trim() || "not-needed",
    baseURL: base,
    maxRetries: 0,
  });
}

function makeProvider(make: (config: AiConfig) => OpenAI): ProviderClient {
  return {
    async listModels(config: AiConfig): Promise<string[]> {
      // Listing models validates the endpoint (and key) with a cheap call.
      const page = await make(config).models.list({ timeout: 8_000 });
      return page.data.map((m) => m.id).sort().slice(0, 100);
    },

    async streamChat(config, messages, onToken, signal): Promise<void> {
      const stream = await make(config).chat.completions.create(
        { model: config.model, messages, stream: true },
        signal ? { signal } : {},
      );
      for await (const chunk of stream) {
        const token = chunk.choices[0]?.delta?.content;
        if (token) await onToken(token);
      }
    },

    async generateText(config: AiConfig, prompt: string): Promise<string> {
      const res = await make(config).chat.completions.create({
        model: config.model,
        messages: [{ role: "user", content: prompt }],
      });
      return res.choices[0]?.message?.content ?? "";
    },
  };
}

export const openaiProvider: ProviderClient = makeProvider(client);
export const localOpenAiProvider: ProviderClient = makeProvider(localClient);
