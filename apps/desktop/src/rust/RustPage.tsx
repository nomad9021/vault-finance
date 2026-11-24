import { useEffect, useRef, useState } from "react";
import { EmptyState, Spinner } from "@vault/ui";
import type { ApiClient } from "@vault/shared";
import { useApp } from "../state/store.js";
import { useChat } from "../state/chat.js";
import type { NavFilter, Navigate, PageId } from "../screens/shell/nav.js";

/**
 * Pages drawn by the Rust UI (crates/vault-ui, Leptos compiled to wasm).
 * Must match `pages::IDS` there. See docs/rust-port.md.
 */
export const RUST_PAGES: ReadonlySet<PageId> = new Set<PageId>([
  "insights",
  "networth",
  "goals",
  "cashflow",
  "income",
  "investments",
  "accounts",
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
