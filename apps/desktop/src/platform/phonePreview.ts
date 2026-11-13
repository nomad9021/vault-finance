/**
 * Design preview of the iPhone app in a desktop browser (`/preview.html`,
 * started by `node scripts/phone-preview.mjs`). It signs straight in to a
 * local demo server full of fake data, so the screens can be worked on
 * without logging in each reload.
 *
 * Development only. Every entry point checks `import.meta.env.DEV`, which
 * Vite replaces with `false` in release builds, so the bundler drops all of
 * it; it also needs the browser host and the `?preview=ios` query, which the
 * Tauri apps never have.
 */

export function isPhonePreview(): boolean {
  return (
    import.meta.env.DEV &&
    !("__TAURI_INTERNALS__" in window) &&
    new URLSearchParams(location.search).get("preview") === "ios"
  );
}

/**
 * The previewed phone's safe areas (`&safe=top,bottom` from preview.html;
 * iPhone 16 by default), so the notch and home-bar padding show up, and its
 * text size (`&text=`, 17 by default) in place of iOS Dynamic Type.
 */
function previewCss(): string {
  const [top = 59, bottom = 34] = (new URLSearchParams(location.search).get("safe") ?? "")
    .split(",")
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 100);
  // `&text=` stands in for the iPhone's Text Size setting (body size in pt).
  const text = Number.parseInt(new URLSearchParams(location.search).get("text") ?? "17", 10);
  const body = Number.isFinite(text) && text >= 12 && text <= 28 ? text : 17;
  return `:root[data-preview="ios"] { --safe-top: ${top}px; --safe-bottom: ${bottom}px; font-size: ${body}px; }`;
}

/** Make the browser look like the iPhone app: iOS styling + safe areas. */
export function applyPhonePreviewLook(): void {
  if (!isPhonePreview()) return;
  const root = document.documentElement;
  root.dataset.platform = "ios";
  root.dataset.preview = "ios";
  const style = document.createElement("style");
  style.textContent = previewCss();
  document.head.append(style);
}

interface StoreKeys {
  getSecret(key: string): Promise<string | null>;
  saveValue(key: string, value: string): Promise<void>;
  setSecret(key: string, value: string): Promise<void>;
  addressKey: string;
  tokensKey: string;
  identityKey(address: string): string;
}

/**
 * Sign in to the demo server as the preview device and save the session
 * where the app looks for it, so bootstrap lands on the dashboard.
 */
export async function signInPhonePreview(store: StoreKeys): Promise<void> {
  if (!isPhonePreview()) return;
  const env = import.meta.env;
  const identity = { deviceId: env.VITE_PREVIEW_DEVICE_ID, deviceSecret: env.VITE_PREVIEW_DEVICE_SECRET };
  if (!env.VITE_PREVIEW_EMAIL || !identity.deviceId) {
    console.error("phone preview: start it with `node scripts/phone-preview.mjs`");
    return;
  }
  const address = location.origin; // Vite proxies /api to the demo server
  // Reuse the saved session (the server rate-limits sign-ins); the app clears
  // it if it has gone stale, and the next load signs in fresh.
  if (await store.getSecret(store.tokensKey)) return;
  const res = await fetch(`${address}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: env.VITE_PREVIEW_EMAIL,
      password: env.VITE_PREVIEW_PASSWORD,
      deviceName: "Phone preview",
      platform: "ios",
      ...identity,
    }),
  });
  if (!res.ok) {
    console.error("phone preview: demo sign-in failed", res.status, await res.text());
    return;
  }
  const { accessToken, refreshToken } = (await res.json()) as { accessToken: string; refreshToken: string };
  await store.saveValue(store.addressKey, address);
  await store.setSecret(store.identityKey(address), JSON.stringify(identity));
  await store.setSecret(store.tokensKey, JSON.stringify({ accessToken, refreshToken }));
}
