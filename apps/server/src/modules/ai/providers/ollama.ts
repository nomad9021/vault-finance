import type { AiConfig, ChatMessage, ProviderClient } from "./types.js";

/**
 * Ollama client — talks to a local/self-hosted Ollama over its native HTTP
 * API. baseUrl comes from ai_settings (never hardcoded; the user may run
 * Ollama on another machine on their network). No API key.
 */
export const ollamaProvider: ProviderClient = {
  async listModels(config: AiConfig): Promise<string[]> {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/api/tags`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) throw new Error(`ollama /api/tags returned ${res.status}`);
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    return (body.models ?? []).map((m) => m.name ?? "").filter(Boolean);
  },

  async streamChat(config, messages, onToken, signal): Promise<void> {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: config.model, messages, stream: true }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`ollama /api/chat returned ${res.status}: ${detail.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as {
          message?: { content?: string };
          done?: boolean;
          error?: string;
        };
        if (parsed.error) throw new Error(`ollama: ${parsed.error}`);
        const content = parsed.message?.content;
        if (content) await onToken(content);
        if (parsed.done) return;
      }
    }
  },

  async generateText(config: AiConfig, prompt: string): Promise<string> {
    const messages: ChatMessage[] = [{ role: "user", content: prompt }];
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: config.model, messages, stream: false }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`ollama /api/chat returned ${res.status}`);
    const body = (await res.json()) as {
      message?: { content?: string };
      error?: string;
    };
    if (body.error) throw new Error(`ollama: ${body.error}`);
    return body.message?.content ?? "";
  },
};
