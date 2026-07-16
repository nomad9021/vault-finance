import { createBrowserPlatform } from "./browser.js";
import type { HostPlatform } from "./types.js";

export type { HostPlatform, ProbeResult } from "./types.js";

let instance: HostPlatform | null = null;

function inTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export async function getPlatform(): Promise<HostPlatform> {
  if (!instance) {
    if (inTauri()) {
      // Dynamic import keeps Tauri modules out of the browser dev bundle.
      const { createTauriPlatform } = await import("./tauri.js");
      instance = await createTauriPlatform();
    } else {
      instance = createBrowserPlatform();
    }
  }
  return instance;
}
