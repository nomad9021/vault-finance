import Anthropic from "@anthropic-ai/sdk";
import type { AiConfig, ChatMessage, ProviderClient } from "./types.js";

/**
 * Anthropic (Claude) client via the official SDK. The user supplies their own
 * API key and chooses the model. The Messages API takes the system prompt as a
 * separate top-level field, so we split our system message out of the array.
 */
function client(config: AiConfig): Anthropic {
  return new Anthropic({ apiKey: config.apiKey ?? "", maxRetries: 1 });
}

function split(messages: ChatMessage[]): {
  system: string;
  convo: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const convo = messages
    .filter((m): m is ChatMessage & { role: "user" | "assistant" } => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));
  return { system, convo };
}

export const anthropicProvider: ProviderClient = {
  async listModels(config: AiConfig): Promise<string[]> {
    // Listing models validates the API key with a cheap authenticated call.
    const page = await client(config).models.list();
    return page.data.map((m) => m.id);
  },

  async streamChat(config, messages, onToken, signal): Promise<void> {
    const { system, convo } = split(messages);
    const stream = client(config).messages.stream(
      { model: config.model, max_tokens: 2048, system, messages: convo },
      signal ? { signal } : {},
    );
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        await onToken(event.delta.text);
      }
    }
  },

  async generateText(config: AiConfig, prompt: string): Promise<string> {
    const res = await client(config).messages.create({
      model: config.model,
      max_tokens: 700,
      messages: [{ role: "user", content: prompt }],
    });
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  },
};
