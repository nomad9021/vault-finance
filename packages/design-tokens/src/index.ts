/**
 * Theme management for the Nocturne-derived token system (src/tokens.css).
 *
 * "dark" is the design's native theme (Nocturne). The others override the
 * custom properties on `:root[data-theme=…]`. "automatic" resolves to
 * light/dark from the OS preference and re-resolves when it changes.
 */

export const THEMES = ["automatic", "dark", "light", "oled", "contrast"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_LABELS: Record<Theme, string> = {
  automatic: "Automatic (follow system)",
  dark: "Dark",
  light: "Light",
  oled: "OLED Black",
  contrast: "High Contrast",
};

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

function systemPrefersLight(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: light)").matches
  );
}

export function resolveTheme(theme: Theme): Exclude<Theme, "automatic"> {
  if (theme !== "automatic") return theme;
  return systemPrefersLight() ? "light" : "dark";
}

let mediaListener: (() => void) | null = null;

/**
 * Apply a theme to the document. Safe to call repeatedly; manages its own
 * prefers-color-scheme listener for the "automatic" case.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.dataset["theme"] = resolveTheme(theme);
  // Native form controls, scrollbars, etc. follow the effective theme.
  root.style.colorScheme = resolveTheme(theme) === "light" ? "light" : "dark";

  const media = window.matchMedia?.("(prefers-color-scheme: light)");
  if (mediaListener) {
    media?.removeEventListener("change", mediaListener);
    mediaListener = null;
  }
  if (theme === "automatic" && media) {
    mediaListener = () => applyTheme("automatic");
    media.addEventListener("change", mediaListener);
  }
}
