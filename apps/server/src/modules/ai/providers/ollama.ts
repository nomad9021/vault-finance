import { ProviderHttpError, type AiConfig, type ChatMessage, type ProviderClient } from "./types.js";

/**
 * Ollama client — talks to a local/self-hosted Ollama over its native HTTP
 * API. baseUrl comes from ai_settings (never hardcoded): the bundled Docker
 * service, or Ollama on a separate machine on your LAN or Tailscale. Plain
 * Ollama has no auth; the optional key is sent as a bearer token for an
 * Ollama that sits behind an authenticating reverse proxy.
 */
function headers(config: AiConfig, json = false): Record<string, string> {
  const h: Record<string, string> = json ? { "content-type": "application/json" } : {};
  if (config.apiKey?.trim()) h["authorization"] = `Bearer ${config.apiKey.trim()}`;
  if (config.priority) h["x-priority"] = config.priority;
  return h;
}

export const ollamaProvider: ProviderClient = {
  async listModels(config: AiConfig): Promise<string[]> {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/api/tags`, {
      headers: headers(config),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new ProviderHttpError(res.status, `ollama /api/tags returned ${res.status}`);
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    return (body.models ?? []).map((m) => m.name ?? "").filter(Boolean);
  },

  async streamChat(config, messages, onToken, signal, onThinking): Promise<void> {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: headers(config, true),
      body: JSON.stringify({ model: config.model, messages, stream: true }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new ProviderHttpError(res.status, `ollama /api/chat returned ${res.status}: ${detail.slice(0, 200)}`);
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
          message?: { content?: string; thinking?: string };
          done?: boolean;
          error?: string;
        };
        if (parsed.error) throw new Error(`ollama: ${parsed.error}`);
        if (parsed.message?.thinking) onThinking?.();
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
      headers: headers(config, true),
      body: JSON.stringify({ model: config.model, messages, stream: false }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new ProviderHttpError(res.status, `ollama /api/chat returned ${res.status}`);
    const body = (await res.json()) as {
      message?: { content?: string };
      error?: string;
    };
    if (body.error) throw new Error(`ollama: ${body.error}`);
    return body.message?.content ?? "";
  },
};
