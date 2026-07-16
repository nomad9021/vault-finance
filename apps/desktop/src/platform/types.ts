import type { FetchLike, Platform as ApiPlatform, StreamFetchLike } from "@vault/shared";

export interface ProbeResult {
  reachable: boolean;
  /** SHA-256 of the server's TLS certificate (DER), hex. Absent when the OS trust store validated the chain or the probe used plain fetch. */
  fingerprint?: string;
  /** True when normal TLS validation succeeded — TOFU pinning is skipped (ADR-0004). */
  trustedByOs?: boolean;
}

/**
 * Everything the React app needs from its host. Two implementations:
 * tauri.ts (Rust shell: pinned TLS fetch, OS keychain, tauri store) and
 * browser.ts (dev mode: plain fetch, localStorage). The React tree never
 * imports Tauri APIs directly — that keeps the frontend reusable for the
 * Phase 2 iOS build, where this interface is re-implemented once.
 */
export interface HostPlatform {
  readonly kind: "tauri" | "browser";
  readonly platformName: ApiPlatform;
  readonly deviceName: string;
  /** Transport for the API client. In Tauri this enforces the pinned fingerprint. */
  readonly fetchImpl: FetchLike;
  /** Chunked transport for AI streaming (ADR-0005), same TLS policy. */
  readonly streamFetchImpl: StreamFetchLike;

  /** Reach the server and capture its certificate identity. */
  probeServer(address: string): Promise<ProbeResult>;
  /** Persist a pin for this address (no-op in browser dev). */
  trustServer(address: string, fingerprint: string | null): Promise<void>;
  /** Previously pinned fingerprint for this address, if any. */
  getPin(address: string): Promise<string | null>;
  /** Drop the pin (Settings → re-verify server identity). */
  forgetPin(address: string): Promise<void>;

  /** Small-value persistent storage (server address, theme). */
  loadValue(key: string): Promise<string | null>;
  saveValue(key: string, value: string): Promise<void>;
  deleteValue(key: string): Promise<void>;

  /** Secret storage — OS keychain in Tauri. Refresh tokens live here. */
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}
