import { CLIENT_ACTION_TYPES, type AiAction, type AiActionRecord } from "@vault/shared";
import { isTheme } from "@vault/design-tokens";
import { useApp } from "../state/store.js";
import { REVIEW_SLIDES, type ReviewSlideId } from "./reviewPrefs.js";

/**
 * Changes the assistant proposes that live on this device (theme, finance
 * review preferences). The server records them; the app carries them out
 * and reports back how it went.
 */

export function isClientAction(a: AiAction): boolean {
  return CLIENT_ACTION_TYPES.has(a.type);
}

async function apply(a: AiAction): Promise<void> {
  const app = useApp.getState();
  if (a.type === "set_theme") {
    if (!isTheme(a.theme)) throw new Error(`"${a.theme}" isn't one of the app's themes.`);
    await app.setTheme(a.theme);
    return;
  }
  if (a.type === "set_review_prefs") {
    const known = new Set<string>(REVIEW_SLIDES);
    const unknown = [...(a.showSlides ?? []), ...(a.hideSlides ?? [])].filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`Unknown review slide: ${unknown.join(", ")}.`);
    const show = new Set(a.showSlides as ReviewSlideId[] | undefined);
    const hide = new Set(a.hideSlides as ReviewSlideId[] | undefined);
    const prev = app.reviewPrefs;
    await app.setReviewPrefs({
      ...prev,
      ...(a.defaultPeriod ? { defaultPeriod: a.defaultPeriod } : {}),
      ...(a.weekStartsOn ? { weekStartsOn: a.weekStartsOn } : {}),
      ...(a.compare !== undefined ? { compare: a.compare } : {}),
      ...(a.autoAdvanceSeconds !== undefined ? { autoAdvanceSeconds: a.autoAdvanceSeconds } : {}),
      ...(a.startFullscreen !== undefined ? { startFullscreen: a.startFullscreen } : {}),
      slides: prev.slides.map((s) =>
        show.has(s.id) ? { ...s, enabled: true } : hide.has(s.id) ? { ...s, enabled: false } : s,
      ),
    });
    return;
  }
  throw new Error("Not a change the app applies itself.");
}

/** Apply on this device, then tell the server the outcome. Returns the updated record. */
export async function applyClientAction(record: AiActionRecord): Promise<AiActionRecord> {
  const { client } = useApp.getState();
  try {
    await apply(record.action);
    return await client.reportAiAction(record.id, { status: "applied" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return await client
      .reportAiAction(record.id, { status: "failed", error: message.slice(0, 500) })
      .catch(() => ({ ...record, status: "failed" as const, error: message }));
  }
}
