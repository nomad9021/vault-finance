import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { platform as osPlatform, hostname } from "@tauri-apps/plugin-os";
import { relaunch } from "@tauri-apps/plugin-process";
import { LazyStore } from "@tauri-apps/plugin-store";
import { check, type Update } from "@tauri-apps/plugin-updater";
import type { Platform as ApiPlatform } from "@vault/shared";
import type {
  BiometricResult,
  BiometricStatus,
  HostPlatform,
  ProbeResult,
  TailscaleActionResult,
  TailscaleStatus,
} from "./types.js";
import { suppressProgrammaticKeyboard } from "./iosKeyboard.js";

interface RustHttpResponse {
  status: number;
  body: string;
}

// Holds the checked Update between checkForUpdate and install — the updater
// plugin's download must reuse the same Update instance.
let pendingUpdate: Update | null = null;

/**
 * Tauri host: every HTTP request goes through the Rust `http_request`
 * command, which enforces the pinned certificate fingerprint per ADR-0004
 * (the webview's own fetch would hard-fail on self-signed certs). Secrets go
 * to the OS keychain via the Rust `keyring` commands; small values to a
 * tauri-plugin-store file.
 */
export async function createTauriPlatform(): Promise<HostPlatform> {
  const store = new LazyStore("settings.json");
  const os = osPlatform();
  const ios = os === "ios";

  // iOS: is the app in front? Leaving it (swipe up, app switcher, Control
  // Centre) makes it inactive before anything else happens, and iOS refuses
  // Face ID until it's active again, so the lock screen waits on this.
  let active = true;
  let waiters: Array<() => void> = [];
  if (ios) {
    const setActive = (v: boolean) => {
      active = v;
      if (v) {
        const w = waiters;
        waiters = [];
        w.forEach((f) => f());
      }
    };
    void listen<string>("vault-system-lock", (e) => {
      if (e.payload === "app-inactive") setActive(false);
    });
    void listen("vault-app-active", () => setActive(true));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") setActive(false);
    });
  }
  if (ios) {
    // Lets the stylesheet clear the notch and home indicator (components.css).
    document.documentElement.dataset.platform = "ios";
    // Keyboard opens only when the user taps a text box (iosKeyboard.ts).
    suppressProgrammaticKeyboard();
  }
  const platformName: ApiPlatform =
    os === "windows" ? "windows" : os === "macos" ? "macos" : ios ? "ios" : "linux";
  // Best-effort: a device name is a nicety, not a reason to fail boot.
  let deviceName = ios ? "iPhone" : `${platformName} desktop`;
  try {
    deviceName = (await hostname()) ?? deviceName;
  } catch (err) {
    console.error("hostname lookup failed; using a generic device name", err);
  }

  const getPin = async (address: string) =>
    (await store.get<string>(`pin:${address}`)) ?? null;

  return {
    kind: "tauri",
    platformName,
    deviceName,

    fetchImpl: async (url, init) => {
      const address = new URL(url).origin;
      const res = await invoke<RustHttpResponse>("http_request", {
        args: {
          url,
          method: init.method,
          headers: init.headers,
          body: init.body ?? null,
          pinnedFingerprint: await getPin(address),
        },
      });
      return { status: res.status, text: async () => res.body };
    },

    streamFetchImpl: async (url, init, onChunk, signal) => {
      const address = new URL(url).origin;
      const channel = new Channel<{ chunk?: string }>();
      channel.onmessage = (msg) => {
        if (msg.chunk && !signal?.aborted) onChunk(msg.chunk);
      };
      const streamId = signal ? crypto.randomUUID() : null;
      signal?.addEventListener("abort", () => void invoke("cancel_stream", { streamId }), { once: true });
      const res = await invoke<{ status: number }>("http_request_stream", {
        args: {
          url,
          method: init.method,
          headers: init.headers,
          body: init.body ?? null,
          pinnedFingerprint: await getPin(address),
          streamId,
        },
        onChunk: channel,
      });
      return { status: res.status };
    },

    async probeServer(address): Promise<ProbeResult> {
      try {
        return await invoke<ProbeResult>("probe_server", { address });
      } catch (err) {
        return { reachable: false, error: String(err) };
      }
    },
    async trustServer(address, fingerprint) {
      if (fingerprint) await store.set(`pin:${address}`, fingerprint);
      await store.save();
    },
    getPin,
    async forgetPin(address) {
      await store.delete(`pin:${address}`);
      await store.save();
    },

    async loadValue(key) {
      return (await store.get<string>(key)) ?? null;
    },
    async saveValue(key, value) {
      await store.set(key, value);
      await store.save();
    },
    async deleteValue(key) {
      await store.delete(key);
      await store.save();
    },

    async checkForUpdate() {
      // iOS has no in-app updater: a new build is installed onto the phone.
      if (ios) return null;
      pendingUpdate = await check();
      return pendingUpdate ? { version: pendingUpdate.version } : null;
    },
    async installUpdateAndRestart(onProgress?: (fraction: number) => void) {
      if (!pendingUpdate) throw new Error("no update pending — check first");
      // Installs Tauri's updater can't replace (extracted AppImage) hand off
      // to the launcher's updater, which quits us, installs, and reopens.
      if (await invoke<boolean>("external_updater_available")) {
        await invoke("run_external_updater");
        return;
      }
      let downloaded = 0;
      let total: number | undefined;
      await pendingUpdate.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength;
        else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (total) onProgress?.(downloaded / total);
        } else if (event.event === "Finished") onProgress?.(1);
      });
      await relaunch();
    },

    // Desktop only. iOS has one window, and the Tailscale app there can't be
    // driven by other apps — the phone just needs it switched on.
    ...(ios
      ? {}
      : {
          async openAdminConsole() {
            await invoke("open_admin_window");
          },
          async tailscaleStatus() {
            return await invoke<TailscaleStatus>("tailscale_status");
          },
          async tailscaleUp() {
            return await invoke<TailscaleActionResult>("tailscale_up");
          },
          async tailscaleDown() {
            return await invoke<TailscaleActionResult>("tailscale_down");
          },
        }),
    ...(ios
      ? {
          isActive: () => active,
          whenActive: () => (active ? Promise.resolve() : new Promise<void>((r) => waiters.push(r))),
        }
      : {}),
    onSystemLock(onLock) {
      let stop: (() => void) | null = null;
      let cancelled = false;
      void listen("vault-system-lock", () => onLock()).then((un) => (cancelled ? un() : (stop = un)));
      // iOS: lock the moment the app leaves the screen (home swipe, app
      // switch, phone locked), so the app switcher's snapshot shows the lock
      // screen rather than balances.
      const onHidden = () => {
        if (document.visibilityState === "hidden") onLock();
      };
      if (ios) document.addEventListener("visibilitychange", onHidden);
      return () => {
        cancelled = true;
        stop?.();
        if (ios) document.removeEventListener("visibilitychange", onHidden);
      };
    },
    async setFullscreen(on) {
      // The iOS app is always full screen.
      if (ios) return;
      await getCurrentWindow().setFullscreen(on);
    },
    async openExternal(url) {
      await invoke("open_external", { url });
    },

    async biometricStatus() {
      try {
        return await invoke<BiometricStatus>("biometric_status");
      } catch {
        return { available: false, label: "Biometrics", reason: "Couldn't check this device." };
      }
    },
    async biometricAuthenticate(reason): Promise<BiometricResult> {
      try {
        await invoke("biometric_authenticate", { reason });
        return { ok: true };
      } catch (err) {
        // Rust serializes BiometricError as "cancelled" | "interrupted" | "failed" | "unavailable: <why>".
        const text = String(err);
        if (text === "cancelled" || text === "interrupted" || text === "failed") return { ok: false, reason: text };
        return { ok: false, reason: "unavailable", message: text.replace(/^unavailable:\s*/, "") };
      }
    },
    async biometricCancel() {
      await invoke("biometric_cancel").catch(() => {});
    },

    async getSecret(key) {
      return await invoke<string | null>("get_secret", { key });
    },
    async setSecret(key, value) {
      await invoke("set_secret", { key, value });
    },
    async deleteSecret(key) {
      await invoke("delete_secret", { key });
    },
  };
}
