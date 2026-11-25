import { useEffect, useRef, useState } from "react";
import { useApp } from "../state/store.js";
import { TAILSCALE_DOWNLOAD_URL, type CheckAction } from "./startupChecks.js";

/** How `runCheckAction` reports back to whoever drew the button. */
export interface CheckActionHooks {
  setMessage(message: string | null): void;
  /** A fix has taken effect (e.g. Tailscale is now connected). */
  onRecovered(): void;
  /** The screen went away: stop waiting. */
  cancelled(): boolean;
}

/** After a browser sign-in starts, wait (up to 3 min) for Tailscale to connect. */
async function waitForTailscale(cancelled: () => boolean) {
  const { refreshTailscale } = useApp.getState();
  const until = Date.now() + 3 * 60_000;
  while (!cancelled() && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2_000));
    const s = await refreshTailscale();
    if (s?.state === "Running") return true;
  }
  return false;
}

/**
 * What the button on a failed check does. Also used by the Rust Settings
 * page (RustPage.tsx); errors reach `setMessage`, never the caller.
 */
export async function runCheckAction(action: CheckAction, hooks: CheckActionHooks): Promise<void> {
  const app = useApp.getState();
  const { setMessage, onRecovered, cancelled } = hooks;
  setMessage(null);
  try {
    switch (action) {
      case "tailscale-up":
      case "tailscale-login": {
        const r = await app.turnOnTailscale();
        if (!r) break;
        if (r.ok && r.status.state === "Running") {
          onRecovered();
        } else if (r.status.authUrl) {
          setMessage("Finish signing in to Tailscale in your browser — this will continue by itself.");
          if (await waitForTailscale(cancelled)) {
            setMessage(null);
            onRecovered();
          } else if (!cancelled()) {
            setMessage("Still waiting for Tailscale. Once you've signed in, press Try again.");
          }
        } else {
          setMessage(r.message ?? "Tailscale didn't connect.");
        }
        break;
      }
      case "tailscale-install":
        await app.platform.openExternal?.(TAILSCALE_DOWNLOAD_URL);
        setMessage("Install Tailscale, sign in, then press Try again.");
        break;
      case "change-server":
        await app.changeServer();
        break;
      case "update-app":
        await app.checkAppUpdate();
        if (useApp.getState().appUpdate.phase === "available") await app.installAppUpdate();
        else setMessage("No app update was found. Update the server or install a newer app from the Releases page.");
        break;
    }
  } catch (err) {
    setMessage(err instanceof Error ? err.message : String(err));
  }
}

/**
 * What the buttons on a failed check do. Shared by the startup screen and
 * Settings → System status. `onRecovered` runs once a fix has taken effect
 * (e.g. Tailscale is now connected) so the caller can re-run its checks.
 */
export function useCheckActions(onRecovered: () => void) {
  const [busy, setBusy] = useState<CheckAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const cancelled = useRef(false);
  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const run = async (action: CheckAction) => {
    setBusy(action);
    try {
      await runCheckAction(action, { setMessage, onRecovered, cancelled: () => cancelled.current });
    } finally {
      if (!cancelled.current) setBusy(null);
    }
  };

  return { busy, message, run };
}
