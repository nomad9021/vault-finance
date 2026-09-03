import { Channel, invoke } from "@tauri-apps/api/core";
import { platform as osPlatform, hostname } from "@tauri-apps/plugin-os";
import { relaunch } from "@tauri-apps/plugin-process";
import { LazyStore } from "@tauri-apps/plugin-store";
import { check, type Update } from "@tauri-apps/plugin-updater";
import type { Platform as ApiPlatform } from "@vault/shared";
import type { HostPlatform, ProbeResult } from "./types.js";

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
  const platformName: ApiPlatform =
    os === "windows" ? "windows" : os === "macos" ? "macos" : "linux";
  // Best-effort: a device name is a nicety, not a reason to fail boot.
  let deviceName = `${platformName} desktop`;
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

    streamFetchImpl: async (url, init, onChunk) => {
      const address = new URL(url).origin;
      const channel = new Channel<{ chunk?: string }>();
      channel.onmessage = (msg) => {
        if (msg.chunk) onChunk(msg.chunk);
      };
      const res = await invoke<{ status: number }>("http_request_stream", {
        args: {
          url,
          method: init.method,
          headers: init.headers,
          body: init.body ?? null,
          pinnedFingerprint: await getPin(address),
        },
        onChunk: channel,
      });
      return { status: res.status };
    },

    async probeServer(address): Promise<ProbeResult> {
      try {
        return await invoke<ProbeResult>("probe_server", { address });
      } catch {
        return { reachable: false };
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
      pendingUpdate = await check();
      return pendingUpdate ? { version: pendingUpdate.version } : null;
    },
    async installUpdateAndRestart(onProgress?: (fraction: number) => void) {
      if (!pendingUpdate) throw new Error("no update pending — check first");
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

    async openAdminConsole() {
      await invoke("open_admin_window");
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
