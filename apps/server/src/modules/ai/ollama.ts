/**
 * Minimal Ollama HTTP client. Host/port always come from ai_settings — never
 * hardcoded (the user may run Ollama on another machine on their network).
 */

export interface OllamaTarget {
  host: string;
  port: number;
}

function baseUrl({ host, port }: OllamaTarget): string {
  return `http://${host}:${port}`;
}

/** List installed model names; throws on unreachable. */
export async function listModels(target: OllamaTarget): Promise<string[]> {
  const res = await fetch(`${baseUrl(target)}/api/tags`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!res.ok) throw new Error(`ollama /api/tags returned ${res.status}`);
  const body = (await res.json()) as { models?: Array<{ name?: string }> };
  return (body.models ?? []).map((m) => m.name ?? "").filter(Boolean);
}

export interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Stream a chat completion. Calls onToken for each content fragment; resolves
 * when Ollama reports done. Throws before the first token if unreachable —
 * callers use that window to return a clean JSON error instead of a stream.
 */
export async function streamChat(
  target: OllamaTarget,
  model: string,
  messages: OllamaChatMessage[],
  onToken: (token: string) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${baseUrl(target)}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true }),
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
}
