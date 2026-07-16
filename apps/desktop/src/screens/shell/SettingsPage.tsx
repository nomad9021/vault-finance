import type { AiStatus, DeviceSession } from "@vault/shared";
import { THEMES, THEME_LABELS } from "@vault/design-tokens";
import { Button, Card, Dialog, Field, Segmented, Select, Spinner, Tag } from "@vault/ui";
import { useCallback, useEffect, useState } from "react";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";

export function SettingsPage() {
  return (
    <div style={{ maxWidth: 640, display: "flex", flexDirection: "column", gap: 16 }}>
      <AppearanceSection />
      <AiSection />
      <SessionsSection />
      <ServerSection />
    </div>
  );
}

function AiSection() {
  const client = useApp((s) => s.client);
  const user = useApp((s) => s.user);
  const { data: status, reload } = useData<AiStatus>(() => client.aiStatus(), [client]);

  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [model, setModel] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status && !dirty) {
      setHost(status.host);
      setPort(String(status.port));
      setModel(status.model);
      setEnabled(status.enabled);
    }
  }, [status, dirty]);

  const isOwner = user?.role === "owner";

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.updateAiSettings({
        ollamaHost: host.trim(),
        ollamaPort: Number(port) || 11434,
        modelName: model.trim(),
        enabled,
      });
      setDirty(false);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save AI settings.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card kicker="AI assistant" title="Local AI (Ollama)">
      {status === null ? (
        <Spinner label="Checking AI status" />
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              aria-hidden="true"
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: !status.enabled
                  ? "var(--color-neutral-600)"
                  : status.reachable
                    ? "var(--color-positive)"
                    : "var(--color-negative)",
              }}
            />
            <span style={{ fontSize: 13 }}>
              {!status.enabled
                ? "Disabled"
                : status.reachable
                  ? `Connected — ${status.availableModels.length} model${status.availableModels.length === 1 ? "" : "s"} available`
                  : `Unreachable at ${status.host}:${status.port}`}
            </span>
            <Button variant="ghost" onClick={reload} style={{ marginLeft: "auto" }}>
              Test connection
            </Button>
          </div>
          {status.enabled && !status.reachable && (
            <p className="card-meta" style={{ lineHeight: 1.6 }}>
              Ollama isn't answering. If you use the bundled Docker service,
              check <code>docker compose logs ollama</code>; otherwise confirm
              the host/port below match where Ollama runs. Every non-AI feature
              keeps working in the meantime.
            </p>
          )}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <div style={{ flex: 2, minWidth: 140 }}>
              <Field
                label="Host"
                value={host}
                disabled={!isOwner}
                onChange={(e) => {
                  setHost(e.target.value);
                  setDirty(true);
                }}
              />
            </div>
            <div style={{ width: 90 }}>
              <Field
                label="Port"
                inputMode="numeric"
                value={port}
                disabled={!isOwner}
                onChange={(e) => {
                  setPort(e.target.value.replace(/\D/g, ""));
                  setDirty(true);
                }}
              />
            </div>
            <div style={{ flex: 2, minWidth: 140 }}>
              {status.availableModels.length > 0 ? (
                <Select
                  label="Model"
                  value={model}
                  disabled={!isOwner}
                  onChange={(e) => {
                    setModel(e.target.value);
                    setDirty(true);
                  }}
                >
                  {!status.availableModels.includes(model) && (
                    <option value={model}>{model} (not pulled)</option>
                  )}
                  {status.availableModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Select>
              ) : (
                <Field
                  label="Model"
                  value={model}
                  disabled={!isOwner}
                  onChange={(e) => {
                    setModel(e.target.value);
                    setDirty(true);
                  }}
                />
              )}
            </div>
          </div>
          <label className="radio" style={{ fontSize: 13 }}>
            <input
              type="checkbox"
              checked={enabled}
              disabled={!isOwner}
              onChange={(e) => {
                setEnabled(e.target.checked);
                setDirty(true);
              }}
            />
            <span className="dot" style={{ borderRadius: 4 }} />
            AI assistant enabled
          </label>
          {error && (
            <div role="alert" style={{ fontSize: 13, color: "var(--color-negative)" }}>
              {error}
            </div>
          )}
          {isOwner ? (
            <div>
              <Button variant="primary" onClick={() => void save()} disabled={!dirty || busy}>
                {busy ? <Spinner label="Saving" /> : "Save & test"}
              </Button>
            </div>
          ) : (
            <p className="card-meta">Only the owner can change AI settings.</p>
          )}
        </>
      )}
    </Card>
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
