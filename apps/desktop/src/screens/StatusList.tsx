import { Button, Icon, Spinner, type IconName } from "@vault/ui";
import type { CheckAction, UiCheck } from "../lib/startupChecks.js";

const LOOK: Record<Exclude<UiCheck["level"], "pending">, { icon: IconName; color: string; word: string }> = {
  ok: { icon: "check", color: "var(--color-positive)", word: "OK" },
  warn: { icon: "alert", color: "var(--color-warning)", word: "Needs attention" },
  error: { icon: "alert", color: "var(--color-negative)", word: "Problem" },
  off: { icon: "minus", color: "var(--content-tertiary)", word: "Off" },
};

const ACTION_LABEL: Record<CheckAction, string> = {
  "tailscale-up": "Turn on Tailscale",
  "tailscale-login": "Sign in to Tailscale",
  "tailscale-install": "Get Tailscale",
  "change-server": "Change server",
  "update-app": "Check for app update",
};

/**
 * The health-check rows used by the startup screen and Settings → System
 * status. Each row: icon, what was checked, what was found, what to do.
 */
export function StatusList({
  checks,
  onAction,
  busyAction,
  hideActions = [],
}: {
  checks: UiCheck[];
  onAction?: (action: CheckAction) => void;
  busyAction?: CheckAction | null;
  hideActions?: CheckAction[];
}) {
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 2 }} aria-live="polite">
      {checks.map((c) => {
        const look = c.level === "pending" ? null : LOOK[c.level];
        const showAction =
          c.action && onAction && !hideActions.includes(c.action) && (c.level === "error" || c.level === "warn" || c.action === "tailscale-up");
        return (
          <li
            key={c.id}
            style={{
              display: "grid",
              gridTemplateColumns: "22px 1fr",
              gap: 10,
              padding: "9px 10px",
              borderRadius: "var(--radius-md)",
              background:
                c.level === "error"
                  ? "var(--color-negative-soft)"
                  : c.level === "warn"
                    ? "var(--color-warning-soft)"
                    : "transparent",
              animation: "fadeUp .25s both",
            }}
          >
            <span style={{ color: look?.color, display: "grid", placeItems: "center", height: 20 }}>
              {look ? (
                <>
                  <Icon name={look.icon} size={16} />
                  <span className="sr-only">{look.word}</span>
                </>
              ) : (
                <Spinner label={`Checking ${c.label}`} />
              )}
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                <span style={{ fontWeight: 600, fontSize: "var(--text-sm)" }}>{c.label}</span>
                {c.detail && (
                  <span style={{ fontSize: "var(--text-sm)", color: "var(--content-secondary)" }}>{c.detail}</span>
                )}
              </div>
              {c.hint && (c.level === "error" || c.level === "warn") && (
                <div style={{ fontSize: "var(--text-xs)", color: "var(--content-secondary)", marginTop: 3, lineHeight: 1.5 }}>
                  {c.hint}
                </div>
              )}
              {showAction && (
                <div style={{ marginTop: 6 }}>
                  <Button
                    variant={c.level === "error" ? "primary" : "secondary"}
                    onClick={() => onAction!(c.action!)}
                    disabled={busyAction != null}
                  >
                    {busyAction === c.action ? <Spinner label="Working" /> : ACTION_LABEL[c.action!]}
                  </Button>
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
