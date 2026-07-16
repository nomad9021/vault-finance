import type { DeviceSession } from "@vault/shared";
import { THEMES, THEME_LABELS } from "@vault/design-tokens";
import { Button, Card, Dialog, Segmented, Spinner, Tag } from "@vault/ui";
import { useCallback, useEffect, useState } from "react";
import { useApp } from "../../state/store.js";

export function SettingsPage() {
  return (
    <div style={{ maxWidth: 640, display: "flex", flexDirection: "column", gap: 16 }}>
      <AppearanceSection />
      <SessionsSection />
      <ServerSection />
    </div>
  );
}

function AppearanceSection() {
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  return (
    <Card kicker="Appearance" title="Theme">
      <p className="card-body">
        Automatic follows your system's light/dark preference.
      </p>
      <Segmented
        aria-label="Theme"
        options={THEMES.map((t) => ({ value: t, label: THEME_LABELS[t].split(" ")[0]! }))}
        value={theme}
        onChange={(t) => void setTheme(t)}
      />
    </Card>
  );
}

function SessionsSection() {
  const client = useApp((s) => s.client);
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null);
  const [confirming, setConfirming] = useState<DeviceSession | null>(null);

  const reload = useCallback(() => {
    client
      .sessions()
      .then((r) => setSessions(r.sessions))
      .catch(() => setSessions([]));
  }, [client]);

  useEffect(reload, [reload]);

  const revoke = async (session: DeviceSession) => {
    await client.revokeSession(session.id).catch(() => {});
    setConfirming(null);
    reload();
  };

  return (
    <Card kicker="Security" title="Devices signed in to your account">
      {sessions === null ? (
        <Spinner label="Loading sessions" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Device</th>
              <th>Platform</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td>
                  {s.deviceName}{" "}
                  {s.isCurrent && (
                    <Tag variant="accent" style={{ marginLeft: 6 }}>
                      this device
                    </Tag>
                  )}
                </td>
                <td style={{ textTransform: "capitalize" }}>{s.platform}</td>
                <td>{new Date(s.lastUsedAt).toLocaleString()}</td>
                <td style={{ textAlign: "right" }}>
                  {!s.isCurrent && (
                    <Button variant="ghost" onClick={() => setConfirming(s)}>
                      Revoke
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Dialog
        open={confirming !== null}
        title="Revoke this device?"
        onClose={() => setConfirming(null)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => confirming && void revoke(confirming)}
            >
              Revoke access
            </Button>
          </>
        }
      >
        “{confirming?.deviceName}” will be signed out immediately and will need
        the account password to sign in again.
      </Dialog>
    </Card>
  );
}

function ServerSection() {
  const serverAddress = useApp((s) => s.serverAddress);
  const platform = useApp((s) => s.platform);
  const changeServer = useApp((s) => s.changeServer);
  const [confirmingChange, setConfirmingChange] = useState(false);

  const rePin = async () => {
    if (serverAddress) await platform.forgetPin(serverAddress);
    await changeServer();
  };

  return (
    <Card kicker="Server" title="Connection">
      <p className="card-body" style={{ fontFamily: "ui-monospace, monospace" }}>
        {serverAddress}
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button variant="secondary" onClick={() => setConfirmingChange(true)}>
          Connect to a different server
        </Button>
        {platform.kind === "tauri" && (
          <Button variant="ghost" onClick={() => void rePin()}>
            Re-verify server identity
          </Button>
        )}
      </div>
      <p className="card-meta">
        Re-verify after rotating your server's TLS certificate — the stored
        fingerprint pin is cleared and confirmed again on the next connect.
      </p>
      <Dialog
        open={confirmingChange}
        title="Disconnect from this server?"
        onClose={() => setConfirmingChange(false)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirmingChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void changeServer()}>
              Disconnect
            </Button>
          </>
        }
      >
        You'll be signed out on this device and asked for a new server address.
        Nothing on the server is affected.
      </Dialog>
    </Card>
  );
}
