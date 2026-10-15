import { useEffect, useRef, useState } from "react";
import { useApp } from "../state/store.js";
import { TAILSCALE_DOWNLOAD_URL, type CheckAction } from "./startupChecks.js";

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

  /** After a browser sign-in starts, wait (up to 3 min) for Tailscale to connect. */
  const waitForTailscale = async () => {
    const { refreshTailscale } = useApp.getState();
    const until = Date.now() + 3 * 60_000;
    while (!cancelled.current && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 2_000));
      const s = await refreshTailscale();
      if (s?.state === "Running") return true;
    }
    return false;
  };

  const run = async (action: CheckAction) => {
    const app = useApp.getState();
    setMessage(null);
    setBusy(action);
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
            if (await waitForTailscale()) {
              setMessage(null);
              onRecovered();
            } else if (!cancelled.current) {
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
    } finally {
      if (!cancelled.current) setBusy(null);
    }
  };

  return { busy, message, run };
}
