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

export const openaiProvider: ProviderClient = {
  async listModels(config: AiConfig): Promise<string[]> {
    // Listing models validates the API key with a cheap authenticated call.
    const page = await client(config).models.list();
    return page.data.map((m) => m.id).sort().slice(0, 100);
  },

  async streamChat(config, messages, onToken, signal): Promise<void> {
    const stream = await client(config).chat.completions.create(
      { model: config.model, messages, stream: true },
      signal ? { signal } : {},
    );
    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content;
      if (token) await onToken(token);
    }
  },

  async generateText(config: AiConfig, prompt: string): Promise<string> {
    const res = await client(config).chat.completions.create({
      model: config.model,
      messages: [{ role: "user", content: prompt }],
    });
    return res.choices[0]?.message?.content ?? "";
  },
};
