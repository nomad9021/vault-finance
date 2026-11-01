import { Button, Spinner } from "@vault/ui";
import { useEffect, useState } from "react";
import { getPrivateNetwork, PRIVATE_NETWORKS, usesTailscaleClient } from "../lib/privateNetwork.js";
import { TAILSCALE_DOWNLOAD_URL } from "../lib/startupChecks.js";
import type { TailscaleStatus } from "../platform/index.js";
import { useApp } from "../state/store.js";

function describe(s: TailscaleStatus, label: string): { text: string; color: string } {
  switch (s.state) {
    case "Running": {
      const ip = s.ips.find((i) => !i.includes(":"));
      return { text: `Connected${ip ? ` · ${ip}` : ""}`, color: "var(--color-positive)" };
    }
    case "NeedsLogin":
      return { text: "Needs you to sign in", color: "var(--color-warning)" };
    case "NeedsMachineAuth":
      return { text: `Waiting for approval in the ${label} admin console`, color: "var(--color-warning)" };
    case "Starting":
      return { text: "Connecting…", color: "var(--color-warning)" };
    case "DaemonDown":
      return { text: "Tailscale service isn't running", color: "var(--color-negative)" };
    case "NotInstalled":
      return { text: "Not installed", color: "var(--content-tertiary)" };
    default:
      return { text: "Off", color: "var(--content-tertiary)" };
  }
}

/**
 * Tailscale on/off from inside the app. `compact` is the one-line strip on
 * the connect screen (only shown when Tailscale is installed but off);
 * otherwise it's the full Settings control including "Turn off".
 */
export function TailscaleControl({ compact = false }: { compact?: boolean }) {
  const platform = useApp((s) => s.platform);
  const status = useApp((s) => s.tailscale);
  const refresh = useApp((s) => s.refreshTailscale);
  const turnOn = useApp((s) => s.turnOnTailscale);
  const turnOff = useApp((s) => s.turnOffTailscale);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const network = getPrivateNetwork();
  const label = PRIVATE_NETWORKS[network].label;
  const supported = Boolean(platform?.tailscaleStatus) && usesTailscaleClient(network);
  useEffect(() => {
    if (supported) void refresh();
  }, [supported, refresh]);

  // While waiting on a browser sign-in, keep polling until it connects.
  useEffect(() => {
    if (!status || (status.state !== "NeedsLogin" && status.state !== "Starting")) return;
    const t = setInterval(() => void refresh(), 3_000);
    return () => clearInterval(t);
  }, [status, refresh]);

  if (!supported || !status) return null;
  if (compact && (status.state === "Running" || status.state === "NotInstalled")) return null;

  const act = async (fn: () => Promise<{ ok: boolean; message?: string; status: TailscaleStatus } | null>) => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await fn();
      if (r && !r.ok) setMessage(r.message ?? "That didn't work.");
      else if (r?.status.authUrl) setMessage(`Finish signing in to ${label} in your browser.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const look = describe(status, label);
  const running = status.state === "Running";

  return (
    <div
      style={{
        display: "grid",
        gap: 8,
        ...(compact
          ? {
              marginTop: 16,
              padding: "10px 12px",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--color-divider)",
              background: "var(--color-bg)",
            }
          : {}),
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: look.color, flex: "none" }} />
        <span style={{ fontSize: "var(--text-sm)" }}>
          <strong>{label}</strong> — {look.text}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {status.state === "NotInstalled" ? (
            <Button variant="secondary" onClick={() => void platform.openExternal?.(TAILSCALE_DOWNLOAD_URL)}>
              Get Tailscale
            </Button>
          ) : running ? (
            !compact && (
              <Button variant="ghost" onClick={() => void act(turnOff)} disabled={busy}>
                {busy ? <Spinner label="Turning off" /> : "Turn off"}
              </Button>
            )
          ) : status.state === "NeedsLogin" && status.authUrl ? (
            <Button variant="primary" onClick={() => void platform.openExternal?.(status.authUrl!)} disabled={busy}>
              Open sign-in page
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void act(turnOn)} disabled={busy || status.state === "DaemonDown"}>
              {busy ? <Spinner label="Turning on" /> : status.state === "NeedsLogin" ? "Sign in" : "Turn on"}
            </Button>
          )}
        </span>
      </div>
      {!compact && running && status.dnsName && (
        <div className="card-meta">This computer is {status.dnsName} on your tailnet.</div>
      )}
      {status.health[0] && <div className="card-meta">{status.health[0]}</div>}
      {status.state === "DaemonDown" && status.error && <div className="card-meta">{status.error}</div>}
      {message && (
        <div role="status" style={{ fontSize: "var(--text-sm)", color: "var(--content-secondary)" }}>
          {message}
        </div>
      )}
      {compact && (
        <div className="card-meta" style={{ fontSize: "var(--text-xs)" }}>
          Only needed if you're away from home and your server is on {label}.
        </div>
      )}
    </div>
  );
}
