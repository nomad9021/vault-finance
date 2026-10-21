import {
  AI_FEATURE_PRIORITY,
  AI_FEATURE_QUALITY,
  AI_LEVEL_QUALITY,
  type AiFeature,
  type AiLevel,
  type AiQuality,
} from "@vault/shared";
import type { AiConfig } from "./providers/index.js";
import type { ResolvedAiSettings } from "./settings.js";

/**
 * The AI Model Manager: the single place that turns a requested quality tier
 * into a concrete model. Every AI call site asks for a quality
 * (AI_FEATURE_QUALITY.*) and gets a provider config with the right model —
 * nothing else in the app references model names directly, so the mapping,
 * the tiers, and the underlying provider can all change here without touching
 * callers or the UI.
 */

/** Resolve a quality tier to a model, falling back to the default model. */
export function resolveModel(settings: ResolvedAiSettings, quality: AiQuality): string {
  const mapped = settings.qualityModels[quality]?.trim();
  if (mapped) return mapped;
  // Fall back to the next-lower configured tier, then the default model.
  const order: AiQuality[] = ["ultra", "high", "normal", "low"];
  const idx = order.indexOf(quality);
  for (let i = idx; i < order.length; i++) {
    const m = settings.qualityModels[order[i]!]?.trim();
    if (m) return m;
  }
  return settings.aiConfig.model;
}

/** Provider config for a given quality — this is what call sites pass on. */
export function configForQuality(settings: ResolvedAiSettings, quality: AiQuality): AiConfig {
  return { ...settings.aiConfig, model: resolveModel(settings, quality) };
}

/**
 * Provider config for an AI feature: its quality tier's model (or the tier
 * for the AI level the user picked), plus the queue priority a local AI
 * server's gateway should give it.
 */
export function configForFeature(settings: ResolvedAiSettings, feature: AiFeature, level?: AiLevel): AiConfig {
  const quality = level ? AI_LEVEL_QUALITY[level] : AI_FEATURE_QUALITY[feature];
  return { ...configForQuality(settings, quality), priority: AI_FEATURE_PRIORITY[feature] };
}
