import type { HostPlatform, ProbeResult } from "./types.js";

/**
 * Browser dev-mode host: plain fetch (the browser owns TLS trust, so TOFU
 * pinning doesn't apply), localStorage for both values and "secrets".
 * Never shipped to users — the desktop build runs the Tauri host.
 */
export function createBrowserPlatform(): HostPlatform {
  const prefix = "vault.";
  return {
    kind: "browser",
    platformName: "linux",
    deviceName: "Browser (dev)",
    fetchImpl: async (url, init) => {
      const res = await fetch(url, init);
      return { status: res.status, text: () => res.text() };
    },

    streamFetchImpl: async (url, init, onChunk) => {
      const res = await fetch(url, init);
      if (!res.body) return { status: res.status };
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        onChunk(decoder.decode(value, { stream: true }));
      }
      return { status: res.status };
    },

    async probeServer(address): Promise<ProbeResult> {
      try {
        const res = await fetch(`${address}/api/v1/version`);
        return { reachable: res.ok, trustedByOs: true };
      } catch {
        return { reachable: false };
      }
    },
    async trustServer() {},
    async getPin() {
      return null;
    },
    async forgetPin() {},

    async loadValue(key) {
      return localStorage.getItem(prefix + key);
    },
    async saveValue(key, value) {
      localStorage.setItem(prefix + key, value);
    },
    async deleteValue(key) {
      localStorage.removeItem(prefix + key);
    },

    async getSecret(key) {
      return localStorage.getItem(prefix + "secret." + key);
    },
    async setSecret(key, value) {
      localStorage.setItem(prefix + "secret." + key, value);
    },
    async deleteSecret(key) {
      localStorage.removeItem(prefix + "secret." + key);
    },
  };
}
