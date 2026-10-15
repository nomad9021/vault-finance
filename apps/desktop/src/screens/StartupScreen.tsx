import { Button } from "@vault/ui";
import { useEffect, useState } from "react";
import { useCheckActions } from "../lib/useCheckActions.js";
import { useApp } from "../state/store.js";
import { AppMark, AuthLayout } from "./AuthLayout.js";
import { StatusList } from "./StatusList.js";

const REVIEW_SECONDS = 4;

/**
 * The loading screen: runs the health checks for the saved server and shows
 * them as they finish. All clear → opens straight away. Warnings → shown for
 * a few seconds, then opens. Errors → stops here with a fix for each.
 */
export function StartupScreen() {
  const startup = useApp((s) => s.startup);
  const runStartup = useApp((s) => s.runStartup);
  const continueFromStartup = useApp((s) => s.continueFromStartup);
  const changeServer = useApp((s) => s.changeServer);
  const { busy, message, run } = useCheckActions(() => void runStartup());
  const [countdown, setCountdown] = useState<number | null>(null);

  useEffect(() => {
    if (startup.phase !== "review") {
      setCountdown(null);
      return;
    }
    setCountdown(REVIEW_SECONDS);
    const t = setInterval(() => {
      setCountdown((n) => {
        if (n === null) return null;
        if (n <= 1) {
          clearInterval(t);
          void continueFromStartup();
          return 0;
        }
        return n - 1;
      });
    }, 1_000);
    return () => clearInterval(t);
  }, [startup.phase, continueFromStartup]);

  const title =
    startup.phase === "blocked"
      ? "Something needs attention"
      : startup.phase === "review"
        ? "Ready, with a note"
        : "Starting Vault Finance";

  return (
    <AuthLayout width={500}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <AppMark size={34} />
        <div>
          <div style={{ fontWeight: 700, fontSize: "var(--text-lg)" }}>{title}</div>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--content-tertiary)" }}>
            {startup.phase === "running" ? "Checking everything is working…" : "System check"}
          </div>
        </div>
      </div>

      <StatusList checks={startup.checks} onAction={(a) => void run(a)} busyAction={busy} />

      {message && (
        <div role="status" style={{ fontSize: "var(--text-sm)", marginTop: 12, color: "var(--content-secondary)" }}>
          {message}
        </div>
      )}

      {startup.phase === "review" && (
        <div style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "center" }}>
          <span style={{ fontSize: "var(--text-sm)", color: "var(--content-tertiary)", marginRight: "auto" }}>
            {countdown !== null && countdown > 0 ? `Opening in ${countdown}…` : "Opening…"}
          </span>
          <Button variant="secondary" onClick={() => setCountdown(null)} disabled={countdown === null}>
            Stay here
          </Button>
          <Button variant="primary" onClick={() => void continueFromStartup()}>
            Open now
          </Button>
        </div>
      )}

      {startup.phase === "blocked" && (
        <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {startup.canContinue && (
            <Button variant="ghost" onClick={() => void continueFromStartup()}>
              Continue anyway
            </Button>
          )}
          <Button variant="secondary" onClick={() => void changeServer()}>
            Change server
          </Button>
          <Button variant="primary" onClick={() => void runStartup()} disabled={busy !== null}>
            Try again
          </Button>
        </div>
      )}
    </AuthLayout>
  );
}
