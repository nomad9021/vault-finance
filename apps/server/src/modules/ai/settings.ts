import type { AiStatus } from "@vault/shared";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import { getProvider, isConfigured, type AiConfig } from "./providers/index.js";

/** Resolve the singleton ai_settings row into a provider config. */
export async function resolveSettings(
  app: FastifyInstance,
  config: AppConfig,
): Promise<{
  enabled: boolean;
  provider: AiConfig["provider"];
  aiConfig: AiConfig;
}> {
  const row = await app.db.query.aiSettings.findFirst();
  // Fallback covers a database that predates the seeded row; AI stays off.
  const provider = row?.provider ?? "ollama";
  return {
    enabled: row?.enabled ?? false,
    provider,
    aiConfig: {
      provider,
      model: row?.model ?? config.ollama.model,
      apiKey: row?.apiKey ?? null,
      baseUrl:
        row?.baseUrl ?? `http://${config.ollama.host}:${config.ollama.port}`,
    },
  };
}

/** Build the public AiStatus (never exposes the API key). */
export async function statusFor(
  settings: Awaited<ReturnType<typeof resolveSettings>>,
): Promise<AiStatus> {
  const { enabled, aiConfig } = settings;
  const configured = isConfigured(aiConfig);
  let availableModels: string[] = [];
  let reachable = false;
  if (enabled && configured) {
    try {
      availableModels = await getProvider(aiConfig.provider).listModels(aiConfig);
      reachable = true;
    } catch {
      reachable = false;
    }
  }
  return {
    enabled,
    configured,
    reachable,
    provider: aiConfig.provider,
    model: aiConfig.model,
    baseUrl: aiConfig.provider === "ollama" ? aiConfig.baseUrl : "",
    hasApiKey: (aiConfig.apiKey?.length ?? 0) > 0,
    availableModels,
  };
}
