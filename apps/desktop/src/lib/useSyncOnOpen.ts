import { useEffect } from "react";
import { useChat } from "../state/chat.js";
import { useApp } from "../state/store.js";

/** Don't ask more often than this from one device (the server also throttles). */
const MIN_GAP_MS = 60_000;
let lastAsked = 0;

/**
 * Bring bank data up to date whenever the app is opened: when the signed-in
 * shell appears (launch, sign-in, unlock) and when the window comes back to
 * the foreground. If new transactions arrived, every open page refetches.
 * Best effort: a server without bank sync, or offline, is simply skipped.
 */
export function useSyncOnOpen(): void {
  const client = useApp((s) => s.client);
  useEffect(() => {
    const sync = () => {
      const now = Date.now();
      if (now - lastAsked < MIN_GAP_MS) return;
      lastAsked = now;
      client
        .bankSyncOnOpen()
        .then((r) => {
          if (r.imported > 0) useChat.getState().refreshData();
        })
        .catch(() => {});
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") sync();
    };
    sync();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", sync);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", sync);
    };
  }, [client]);
}
