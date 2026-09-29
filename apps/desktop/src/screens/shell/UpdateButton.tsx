import { Button, Icon, ProgressBar, Spinner } from "@vault/ui";
import { useEffect, useRef, useState } from "react";
import { APP_VERSION, useApp } from "../../state/store.js";

const RELEASES_URL = "https://github.com/nomad9021/vault-finance/releases/latest";

/**
 * Header control next to the account avatar: shows a dot when a new desktop
 * release is waiting and installs it in place. Shares its state with the
 * Updates card in Settings (both read `appUpdate` from the store). Hidden in
 * browser dev mode, which has no updater.
 */
export function UpdateButton() {
  const platform = useApp((s) => s.platform);
  const update = useApp((s) => s.appUpdate);
  const checkAppUpdate = useApp((s) => s.checkAppUpdate);
  const installAppUpdate = useApp((s) => s.installAppUpdate);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (platform.kind !== "tauri") return null;

  const ready = update.phase === "available" || update.phase === "installing";
  const toggle = () => {
    const next = !open;
    setOpen(next);
    // Opening it with nothing known yet is an implicit "check now".
    if (next && (update.phase === "idle" || update.phase === "none")) void checkAppUpdate();
  };

  return (
    <div style={{ position: "relative" }} ref={ref}>
      <Button
        variant="ghost"
        icon="download"
        onClick={toggle}
        aria-label={ready ? "Update available" : "App updates"}
        title={ready ? "Update available" : "App updates"}
      />
      {ready && <span className="update-dot" aria-hidden="true" />}
      {open && (
        <div
          className="menu"
          style={{ right: 0, top: "calc(100% + var(--space-2))", width: 280 }}
          role="dialog"
          aria-label="App updates"
        >
          <div className="menu-head">
            <div className="t-sm t-semibold">Vault Finance</div>
            <div className="t-xs t-tertiary">Installed: v{APP_VERSION}</div>
          </div>
          <div style={{ padding: "var(--space-2) var(--space-3) var(--space-3)", display: "grid", gap: 10 }}>
            {update.phase === "available" && (
              <>
                <div className="t-sm">
                  <strong>v{update.version}</strong> is ready to install. The app restarts when it's done.
                </div>
                <Button variant="primary" block onClick={() => void installAppUpdate()}>
                  Install &amp; restart
                </Button>
              </>
            )}
            {update.phase === "installing" && (
              <>
                <div className="t-sm">
                  Downloading v{update.version}… {Math.round(update.progress * 100)}%
                </div>
                <ProgressBar value={update.progress} small label="Download progress" />
              </>
            )}
            {(update.phase === "idle" || update.phase === "checking") && (
              <div className="row t-sm" style={{ gap: 8 }}>
                <Spinner label="Checking for updates" /> Checking for updates…
              </div>
            )}
            {update.phase === "none" && (
              <>
                <div className="row t-sm" style={{ gap: 8 }}>
                  <Icon name="check" size={16} /> You're on the latest version.
                </div>
                <Button variant="secondary" block onClick={() => void checkAppUpdate()}>
                  Check again
                </Button>
              </>
            )}
            {update.phase === "error" && (
              <>
                <div role="alert" className="t-sm" style={{ color: "var(--color-negative)" }}>
                  {update.version ? "The update couldn't be installed" : "Couldn't check for updates"}:{" "}
                  {update.message}
                </div>
                {update.version && (
                  <div className="t-xs t-tertiary">
                    You can download v{update.version} manually from{" "}
                    <span style={{ userSelect: "all", wordBreak: "break-all" }}>{RELEASES_URL}</span>
                  </div>
                )}
                <Button
                  variant="secondary"
                  block
                  onClick={() => void (update.version ? installAppUpdate() : checkAppUpdate())}
                >
                  Try again
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
