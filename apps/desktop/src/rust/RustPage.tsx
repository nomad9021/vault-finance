import { useEffect, useRef, useState } from "react";
import { EmptyState, Spinner } from "@vault/ui";
import type { ApiClient, User } from "@vault/shared";
import { APP_VERSION, useApp } from "../state/store.js";
import { useChat } from "../state/chat.js";
import { readSpreadsheet, SpreadsheetError } from "../lib/spreadsheet.js";
import { keepUnlocked } from "../lib/autoLock.js";
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
  "settings",
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
      return {
        reviewPrefs: s.reviewPrefs,
        aiVisible: s.aiVisible,
        platform: s.platform.kind,
        user: s.user,
        householdName: s.householdName,
        appUpdate: s.appUpdate,
        activeAddress: s.activeAddress,
        baseUrl: client.baseUrl,
        appVersion: APP_VERSION,
        adminConsole: Boolean(s.platform.openAdminConsole),
      };
    },
    setFullscreen(on: boolean): Promise<void> {
      return useApp.getState().platform.setFullscreen(on);
    },
    /** `useKeepUnlocked()` for Rust: call the result to release. */
    keepUnlocked,
    /** Run `cb` when what `app()` returns changes; returns an unsubscribe. */
    onAppStateChange(cb: () => void): () => void {
      return useApp.subscribe((s, prev) => {
        if (
          s.reviewPrefs !== prev.reviewPrefs ||
          s.aiVisible !== prev.aiVisible ||
          s.platform !== prev.platform ||
          s.user !== prev.user ||
          s.householdName !== prev.householdName ||
          s.appUpdate !== prev.appUpdate ||
          s.activeAddress !== prev.activeAddress
        )
          cb();
      });
    },
    /** Settings: the profile the server sent back after an edit. */
    setUser(user: User) {
      useApp.setState({ user });
    },
    setHouseholdName(name: string) {
      useApp.getState().setHouseholdName(name);
    },
    /** The header's app-update state machine; Settings reads `app().appUpdate`. */
    checkAppUpdate() {
      void useApp.getState().checkAppUpdate();
    },
    installAppUpdate() {
      void useApp.getState().installAppUpdate();
    },
    loadValue(key: string): Promise<string | null> {
      return useApp.getState().platform.loadValue(key);
    },
    saveValue(key: string, value: string) {
      void useApp.getState().platform.saveValue(key, value);
    },
    openExternal(url: string) {
      const platform = useApp.getState().platform;
      if (platform.openExternal) void platform.openExternal(url);
      else window.open(url, "_blank", "noopener");
    },
    openAdminConsole() {
      void useApp.getState().platform.openAdminConsole?.();
    },
    copyText(text: string): Promise<void> {
      return navigator.clipboard.writeText(text);
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
