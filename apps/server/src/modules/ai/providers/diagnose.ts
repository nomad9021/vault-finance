import { LOCAL_PROVIDERS } from "@vault/shared";
import type { AiConfig } from "./types.js";

/**
 * Turn a provider failure into something a person can act on. Most failures
 * with a separate AI machine are networking ones (wrong port, Ollama only
 * listening on localhost, a firewall), and the raw "fetch failed" says none
 * of that.
 */
export function describeAiError(err: unknown, config: Pick<AiConfig, "provider" | "baseUrl">): {
  error: string;
  hint: string;
} {
  const local = LOCAL_PROVIDERS.has(config.provider);
  const ollama = config.provider === "ollama";
  const code = findCode(err);
  const status = findStatus(err);
  const host = hostOf(config.baseUrl);
  const port = portOf(config.baseUrl);
  const networkFailure = code !== undefined && !/CERT|SSL|TLS|SELF_SIGNED/.test(code);

  if (local && networkFailure && host && /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/.test(host)) {
    // Inside Docker this is the commonest mistake: nothing answers because
    // "localhost" is the Vault container itself.
    return {
      error: `“${host}” points at the Vault server's own container, not your AI machine.`,
      hint:
        "Use the AI machine's network address instead — its LAN IP (e.g. 192.168.1.50) or Tailscale IP (100.x.y.z). " +
        "If the AI runs on the same computer as the Vault server, use host.docker.internal" +
        (port ? `:${port}` : "") +
        ".",
    };
  }

  if (code === "ECONNREFUSED") {
    return {
      error: `The machine at ${host ?? "that address"} answered, but nothing is listening on port ${port ?? "?"}.`,
      hint: ollama
        ? "On the AI machine, make sure Ollama is running and listening on the network: set OLLAMA_HOST=0.0.0.0 and restart Ollama. Its default port is 11434."
        : "Make sure the AI server is running and listening on the network, not just localhost (LM Studio: turn on “Serve on local network”; llama-server/vLLM: --host 0.0.0.0).",
    };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return {
      error: `The Vault server couldn't find a machine called “${host}”.`,
      hint: "Use the AI machine's IP address instead of its name — a LAN address like 192.168.1.50, or its Tailscale 100.x address.",
    };
  }
  if (
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "TimeoutError" ||
    code === "APIConnectionTimeoutError"
  ) {
    return {
      error: `No answer from ${host ?? "the AI server"} in time.`,
      hint:
        "Check that the AI machine is switched on and on the same network as the Vault server (or both are on Tailscale), " +
        `and that its firewall allows port ${port ?? (ollama ? 11434 : "the AI server's port")}.`,
    };
  }
  if (code && /CERT|SSL|TLS|SELF_SIGNED/.test(code)) {
    return {
      error: "The AI server's HTTPS certificate wasn't accepted.",
      hint: "For a machine on your own network, use http:// — or give the server a valid certificate.",
    };
  }
  if (status === 401 || status === 403) {
    return {
      error: "The AI provider refused the request (not authorized).",
      hint: local
        ? "This server wants a key or token. Enter it in the API key field (it's stored only on your Vault server)."
        : "Check the API key — it may be mistyped, revoked, or out of credit.",
    };
  }
  if (status === 404) {
    return {
      error: "Reached a server, but not the AI API at that address.",
      hint: ollama
        ? "Ollama's URL is just the host and port, like http://192.168.1.50:11434 — without /v1 or /api."
        : "OpenAI-compatible servers usually need /v1 at the end, like http://192.168.1.50:1234/v1.",
    };
  }
  if (err instanceof SyntaxError) {
    return {
      error: "Something answered, but it isn't an AI API (it may be a web page).",
      hint: "Double-check the port number in the address.",
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    error: local ? "Couldn't reach the AI server." : "Couldn't reach the AI provider.",
    hint: message.slice(0, 200),
  };
}

/** Dig a network error code out of nested causes (undici, SDKs, AggregateError). */
function findCode(err: unknown, depth = 0): string | undefined {
  if (!err || typeof err !== "object" || depth > 6) return undefined;
  const e = err as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
  if (typeof e.code === "string" && /^[A-Z_]+$/.test(e.code)) return e.code;
  if (e.name === "TimeoutError" || e.name === "APIConnectionTimeoutError") return e.name;
  const nested = findCode(e.cause, depth + 1);
  if (nested) return nested;
  if (Array.isArray(e.errors)) {
    for (const inner of e.errors) {
      const c = findCode(inner, depth + 1);
      if (c) return c;
    }
  }
  return undefined;
}

function findStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    const s = (err as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  return undefined;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

function portOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.port || (u.protocol === "https:" ? "443" : "80");
  } catch {
    return undefined;
  }
}
