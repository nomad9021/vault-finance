import { useEffect, useRef, useState } from "react";
import { EmptyState, Spinner } from "@vault/ui";
import type { ApiClient } from "@vault/shared";
import { useApp, type AppState } from "../state/store.js";
import { useChat } from "../state/chat.js";
import { readSpreadsheet, SpreadsheetError } from "../lib/spreadsheet.js";
import { keepUnlocked } from "../lib/autoLock.js";
import { runChecks } from "../lib/startupChecks.js";
import { runCheckAction } from "../lib/useCheckActions.js";
import { APP_VERSION, deviceKeySecret } from "../state/store.js";
import type { NavFilter, Navigate, PageId } from "../screens/shell/nav.js";

/**
 * Pages drawn by the Rust UI (crates/vault-ui, Leptos compiled to wasm).
 * Must match `pages::IDS` there. See docs/rust-port.md.
 */
export const RUST_PAGES: ReadonlySet<PageId> = new Set<PageId>([
  "insights",
  "networth",
  "subscriptions",
  "goals",
  "cashflow",
  "bills",
  "income",
  "investments",
  "accounts",
  "budgets",
  "taxes",
  "giving",
  "reports",
]);

const FLAG = "vault.rust-ui";

/**
 * Rust pages are on by default in dev builds and opt-in in releases until
 * each one has been checked on real data: `localStorage["vault.rust-ui"]`
 * = "on" | "off" overrides either way.
 */
export function rustUiEnabled(): boolean {
  const v = typeof localStorage === "undefined" ? null : localStorage.getItem(FLAG);
  if (v === "on") return true;
  if (v === "off") return false;
  return import.meta.env.DEV;
}

export function setRustUiEnabled(on: boolean) {
  localStorage.setItem(FLAG, on ? "on" : "off");
}

export function usesRust(page: PageId): boolean {
  return RUST_PAGES.has(page) && rustUiEnabled();
}

type Wasm = typeof import("./pkg/vault_ui.js");
let wasm: Promise<Wasm> | null = null;
function loadWasm(): Promise<Wasm> {
  wasm ??= import("./pkg/vault_ui.js").then(async (m) => {
    await m.default();
    return m;
  });
  return wasm;
}

/** The object `crates/vault-ui/src/host.rs` binds to. Keep the two in sync. */
function makeHost(client: ApiClient, onNavigate: Navigate, filter: NavFilter) {
  return {
    call(method: string, args: unknown[]): Promise<unknown> {
      const fn = (client as unknown as Record<string, unknown>)[method];
      if (typeof fn !== "function" || method.startsWith("_") || method === "constructor") {
        return Promise.reject(new Error(`ApiClient has no method ${method}`));
      }
      return Promise.resolve((fn as (...a: unknown[]) => unknown).apply(client, args));
    },
    /** What the page was opened with (in-page tab, account…). */
    filter(): NavFilter {
      return filter;
    },
    navigate(page: string, filter?: NavFilter) {
      onNavigate(page as PageId, filter && Object.keys(filter).length ? filter : undefined);
    },
    /** Every page refetches (what a React page's edit does via useChat). */
    refreshData() {
      useChat.getState().refreshData();
    },
    onDataChange(cb: () => void): () => void {
      return useChat.subscribe((s, prev) => {
        if (s.dataVersion !== prev.dataVersion) cb();
      });
    },
    /** Store settings a page reads (the review presenter's prefs, AI on/off). */
    app() {
      const s = useApp.getState();
      return { reviewPrefs: s.reviewPrefs, aiVisible: s.aiVisible, platform: s.platform.kind };
    },
    setFullscreen(on: boolean): Promise<void> {
      return useApp.getState().platform.setFullscreen(on);
    },
    /** `useKeepUnlocked()` for Rust: call the result to release. */
    keepUnlocked,
    /** Run `cb` when what `app()` returns changes; returns an unsubscribe. */
    onAppStateChange(cb: () => void): () => void {
      return useApp.subscribe((s, prev) => {
        if (s.reviewPrefs !== prev.reviewPrefs || s.aiVisible !== prev.aiVisible || s.platform !== prev.platform) cb();
      });
    },
    /**
     * A picked CSV/TSV/Excel file as `{ name, content }` (CSV text), parsed by
     * lib/spreadsheet.ts. Its own messages reject with name "SpreadsheetError".
     */
    async readSpreadsheet(file: File): Promise<{ name: string; content: string }> {
      try {
        return await readSpreadsheet(file);
      } catch (err) {
        if (err instanceof SpreadsheetError) {
          const e = new Error(err.message);
          e.name = "SpreadsheetError";
          throw e;
        }
        throw err;
      }
    },
    /** A new assistant chat with `attachment`, opened, sending `message`. */
    askAssistant(message: string, attachment: { name: string; content: string } | null) {
      const chat = useChat.getState();
      chat.newChat();
      chat.attach(attachment);
      onNavigate("assistant");
      void chat.send(message);
    },

    // ── Settings (part B): the store and platform pieces its sections use ──

    /** The `useApp` fields Settings draws (vault-core `SettingsState`). */
    settingsState() {
      return settingsSnapshot(useApp.getState());
    },
    /** Run `cb` when `settingsState()` changes; returns an unsubscribe. */
    onSettingsStateChange(cb: () => void): () => void {
      return useApp.subscribe((s, prev) => {
        if (SETTINGS_FIELDS.some((k) => s[k] !== prev[k])) cb();
      });
    },
    /** A `useApp` action Settings may run, by name. */
    store(action: string, args: unknown[]): Promise<unknown> {
      if (!SETTINGS_ACTIONS.has(action)) return Promise.reject(new Error(`no store action ${action}`));
      const fn = useApp.getState()[action as keyof AppState] as (...a: unknown[]) => unknown;
      return Promise.resolve(fn(...args));
    },
    /** `platform.openExternal(url)`, or a new browser tab. */
    openExternal(url: string) {
      const platform = useApp.getState().platform;
      if (platform.openExternal) void platform.openExternal(url);
      else window.open(url, "_blank", "noopener");
    },
    /** The id of this device's biometric key for the signed-in user, if any. */
    async thisDeviceKeyId(): Promise<string | null> {
      const { platform, serverAddress, user } = useApp.getState();
      if (!serverAddress || !user) return null;
      try {
        const raw = await platform.getSecret(deviceKeySecret(serverAddress, user.id));
        return raw ? ((JSON.parse(raw) as { id?: string }).id ?? null) : null;
      } catch {
        return null;
      }
    },
    forgetPin(address: string): Promise<void> {
      return useApp.getState().platform.forgetPin(address);
    },
    biometricCancel(): Promise<void> {
      return Promise.resolve(useApp.getState().platform.biometricCancel());
    },
    /** Settings → System status: the startup checks, with progress. */
    async runChecks(onUpdate: (checks: unknown[]) => void): Promise<unknown[] | null> {
      const s = useApp.getState();
      if (!s.serverAddress) return null;
      const outcome = await runChecks(
        {
          platform: s.platform,
          client: s.client,
          address: s.serverAddress,
          appVersion: APP_VERSION,
          keychainOk: s.keychainOk,
          hasSession: true,
          alternateAddress: s.alternateAddress,
          onRoute: s.setActiveAddress,
        },
        onUpdate,
      );
      return outcome.checks;
    },
    /** A failed check's button (lib/useCheckActions.ts). */
    runCheckAction(
      action: string,
      setMessage: (m: string | null) => void,
      onRecovered: () => void,
      cancelled: () => boolean,
    ): Promise<void> {
      return runCheckAction(action as Parameters<typeof runCheckAction>[0], { setMessage, onRecovered, cancelled });
    },
  };
}

const SETTINGS_FIELDS = [
  "user",
  "theme",
  "showSankey",
  "aiVisible",
  "aiAutoApply",
  "aiLevel",
  "autoLockMinutes",
  "biometric",
  "biometricUserIds",
  "serverAddress",
  "alternateAddress",
  "activeAddress",
  "tailscale",
  "platform",
] as const satisfies ReadonlyArray<keyof AppState>;

const SETTINGS_ACTIONS: ReadonlySet<string> = new Set([
  "setShowSankey",
  "setTheme",
  "setAiAutoApply",
  "setAiLevel",
  "setAutoLockMinutes",
  "setReviewPrefs",
  "lock",
  "enableBiometric",
  "disableBiometric",
  "refreshAiEnabled",
  "refreshTailscale",
  "turnOnTailscale",
  "turnOffTailscale",
  "saveAlternateAddress",
  "removeAlternateAddress",
  "changeServer",
  "signOut",
] satisfies ReadonlyArray<keyof AppState>);

function settingsSnapshot(s: AppState) {
  return {
    userId: s.user?.id ?? null,
    role: s.user?.role ?? null,
    theme: s.theme,
    showSankey: s.showSankey,
    aiVisible: s.aiVisible,
    aiAutoApply: s.aiAutoApply,
    aiLevel: s.aiLevel,
    autoLockMinutes: s.autoLockMinutes,
    biometric: s.biometric,
    biometricUserIds: s.biometricUserIds,
    serverAddress: s.serverAddress,
    alternateAddress: s.alternateAddress,
    activeAddress: s.activeAddress,
    tailscale: s.tailscale,
    tailscaleSupported: Boolean(s.platform?.tailscaleStatus),
    platform: s.platform?.kind ?? "browser",
  };
}

/** Mounts a Rust page into a div and tears it down on page change. */
export function RustPage({
  page,
  filter = {},
  onNavigate,
}: {
  page: PageId;
  filter?: NavFilter;
  onNavigate: Navigate;
}) {
  const client = useApp((s) => s.client);
  const ref = useRef<HTMLDivElement>(null);
  const nav = useRef(onNavigate);
  nav.current = onNavigate;
  // Read at mount, like a React page's `useState(initialTab)`.
  const initialFilter = useRef(filter);
  initialFilter.current = filter;
  const [state, setState] = useState<"loading" | "ready" | Error>("loading");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let mounted: { unmount(): void; free(): void } | null = null;
    let cancelled = false;
    setState("loading");
    loadWasm()
      .then((m) => {
        if (cancelled) return;
        mounted = m.mount(
          el,
          page,
          makeHost(client, (p, f) => nav.current(p, f), initialFilter.current),
        );
        setState("ready");
      })
      .catch((err: unknown) => {
        if (!cancelled) setState(err instanceof Error ? err : new Error(String(err)));
      });
    return () => {
      cancelled = true;
      if (mounted) {
        mounted.unmount();
        mounted.free();
      }
    };
  }, [page, client]);

  return (
    <>
      {state === "loading" && <Spinner />}
      {state instanceof Error && (
        <div className="panel">
          <EmptyState icon="alert" title="This page didn't load" body={state.message} />
        </div>
      )}
      <div ref={ref} data-rust-page={page} style={{ display: "contents" }} />
    </>
  );
}
