import {
  AI_MODEL_SUGGESTIONS,
  AI_PROVIDER_LABELS,
  AiProvider,
  CLOUD_PROVIDERS,
  type AiStatus,
  type DeviceSession,
} from "@vault/shared";
import { THEMES, THEME_LABELS } from "@vault/design-tokens";
import { Button, Card, Dialog, Field, Segmented, Select, Spinner, Tag } from "@vault/ui";
import { useCallback, useEffect, useState } from "react";
import { useData } from "../../lib/useData.js";
import { APP_VERSION, useApp } from "../../state/store.js";

export function SettingsPage() {
  return (
    <div style={{ maxWidth: 640, display: "flex", flexDirection: "column", gap: 16 }}>
      <AppearanceSection />
      <CategoriesSection />
      <AiSection />
      <UpdatesSection />
      <SessionsSection />
      <ServerSection />
    </div>
  );
}

/**
 * Manage spending categories and nest them under a parent. Nesting is what
 * makes the dashboard's cash-flow Sankey branch (a parent category → its
 * children). Parent options are top-level categories only, which keeps the
 * tree acyclic without extra bookkeeping.
 */
function CategoriesSection() {
  const client = useApp((s) => s.client);
  const { data, reload } = useData(() => client.categories(), [client]);
  const categories = data?.categories ?? [];
  const topLevel = categories.filter((c) => !c.parentCategoryId);
  const childrenOf = (id: string) => categories.filter((c) => c.parentCategoryId === id);

  const [name, setName] = useState("");
  const [color, setColor] = useState("#7c5cff");
  const [parentId, setParentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await client.createCategory({
        name: name.trim(),
        color,
        parentCategoryId: parentId || null,
      });
      setName("");
      setColor("#7c5cff");
      setParentId("");
      await reload();
    } catch {
      setError("Couldn't add that category.");
    } finally {
      setBusy(false);
    }
  };

  const reparent = async (id: string, newParent: string) => {
    setError(null);
    await client.updateCategory(id, { parentCategoryId: newParent || null }).catch(() => {});
    await reload();
  };
  const remove = async (id: string) => {
    setError(null);
    try {
      await client.deleteCategory(id);
      await reload();
    } catch {
      setError(
        "That category is in use (has transactions or budgets) or is a system default — reassign those first.",
      );
    }
  };

  const row = (cat: (typeof categories)[number], indented: boolean) => (
    <div
      key={cat.id}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "7px 0",
        paddingLeft: indented ? 22 : 0,
        borderTop: "1px solid var(--color-divider)",
      }}
    >
      <span
        style={{
          width: 12,
          height: 12,
          borderRadius: 3,
          background: cat.color,
          flex: "0 0 auto",
        }}
      />
      <span style={{ fontWeight: 600, fontSize: 13 }}>
        {indented ? "↳ " : ""}
        {cat.name}
      </span>
      {cat.isSystem && <Tag>system</Tag>}
      <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
        <Select
          value={cat.parentCategoryId ?? ""}
          onChange={(e) => reparent(cat.id, e.target.value)}
          aria-label={`Parent category of ${cat.name}`}
        >
          <option value="">Top level</option>
          {topLevel
            .filter((p) => p.id !== cat.id)
            .map((p) => (
              <option key={p.id} value={p.id}>
                under {p.name}
              </option>
            ))}
        </Select>
        {!cat.isSystem && (
          <Button variant="ghost" onClick={() => remove(cat.id)}>
            Delete
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <Card kicker="Categories" title="Categories & sub-categories">
      <p className="card-meta">
        Nest a category under a parent to make the cash-flow diagram branch — e.g. an
        “Investments” parent with “401(k)”, “House Fund”, and “Brokerage” beneath it.
      </p>

      <div style={{ margin: "12px 0" }}>
        {topLevel.map((p) => (
          <div key={p.id}>
            {row(p, false)}
            {childrenOf(p.id).map((ch) => row(ch, true))}
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ flex: 2, minWidth: 150 }}>
          <Field
            label="New category"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Investments or 401(k)"
          />
        </div>
        <div style={{ width: 84 }}>
          <Field label="Color" type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </div>
        <div style={{ flex: 1, minWidth: 150 }}>
          <Select label="Parent" value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">None (top level)</option>
            {topLevel.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>
        <Button variant="primary" onClick={add} disabled={busy || !name.trim()}>
          Add
        </Button>
      </div>
      {error && (
        <div role="alert" style={{ fontSize: 13, color: "var(--color-negative)", marginTop: 8 }}>
          {error}
        </div>
      )}
    </Card>
  );
}

function UpdatesSection() {
  const platform = useApp((s) => s.platform);
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "checking" }
    | { phase: "none" }
    | { phase: "available"; version: string }
    | { phase: "installing"; progress: number }
    | { phase: "error"; message: string }
  >({ phase: "idle" });

  // Browser dev mode has no updater — hide the card entirely.
  if (platform.kind !== "tauri") return null;

  const check = async () => {
    setState({ phase: "checking" });
    try {
      const update = await platform.checkForUpdate();
      setState(update ? { phase: "available", version: update.version } : { phase: "none" });
    } catch (err) {
      setState({
        phase: "error",
        message: err instanceof Error ? err.message : "Couldn't reach the update server.",
      });
    }
  };

  const install = async () => {
    setState({ phase: "installing", progress: 0 });
    try {
      await platform.installUpdateAndRestart((progress) =>
        setState({ phase: "installing", progress }),
      );
    } catch (err) {
      setState({
        phase: "error",
        message: err instanceof Error ? err.message : "The update failed to install.",
      });
    }
  };

  return (
    <Card kicker="Application" title={`Updates — v${APP_VERSION}`}>
      <p className="card-body">
        Updates are downloaded from the project's GitHub releases and
        signature-checked before install — the only network request this app
        ever makes outside your own server.
      </p>
      {state.phase === "available" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Tag variant="accent">v{state.version} available</Tag>
          <Button variant="primary" onClick={() => void install()}>
            Install & restart
          </Button>
        </div>
      ) : state.phase === "installing" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Spinner label="Installing update" />
          <span style={{ fontSize: 13 }}>
            Downloading… {Math.round(state.progress * 100)}%
          </span>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Button
            variant="secondary"
            onClick={() => void check()}
            disabled={state.phase === "checking"}
          >
            {state.phase === "checking" ? <Spinner label="Checking" /> : "Check for updates"}
          </Button>
          {state.phase === "none" && (
            <span style={{ fontSize: 13, color: "var(--color-neutral-500)" }}>
              You're on the latest version.
            </span>
          )}
          {state.phase === "error" && (
            <span role="alert" style={{ fontSize: 13, color: "var(--color-negative)" }}>
              {state.message}
            </span>
          )}
        </div>
      )}
    </Card>
  );
}

function AiSection() {
  const client = useApp((s) => s.client);
  const user = useApp((s) => s.user);
  const refreshAiEnabled = useApp((s) => s.refreshAiEnabled);
  const { data: status, reload } = useData<AiStatus>(() => client.aiStatus(), [client]);

  const [provider, setProvider] = useState<AiProvider>("ollama");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the form from server state until the user starts editing.
  useEffect(() => {
    if (status && !dirty) {
      setProvider(status.provider);
      setModel(status.model);
      setBaseUrl(status.baseUrl);
      setEnabled(status.enabled);
      setApiKey(""); // never populated — the key is write-only
    }
  }, [status, dirty]);

  const isOwner = user?.role === "owner";
  const touch = () => setDirty(true);
  const isCloud = CLOUD_PROVIDERS.has(provider);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.updateAiSettings({
        enabled,
        provider,
        model: model.trim(),
        // Only send the key when the user typed one — blank leaves the stored
        // key untouched (they can clear it with the button below).
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        baseUrl: baseUrl.trim(),
      });
      setApiKey("");
      setDirty(false);
      reload();
      await refreshAiEnabled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save AI settings.");
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async () => {
    setBusy(true);
    try {
      await client.updateAiSettings({ enabled, provider, model: model.trim(), apiKey: "", baseUrl: baseUrl.trim() });
      setApiKey("");
      setDirty(false);
      reload();
      await refreshAiEnabled();
    } finally {
      setBusy(false);
    }
  };

  const statusLine = (s: AiStatus): string => {
    if (!s.enabled) return "Off";
    if (!s.configured) return "Needs configuration";
    if (s.reachable) {
      return s.availableModels.length > 0
        ? `Connected — ${s.availableModels.length} model${s.availableModels.length === 1 ? "" : "s"} available`
        : "Connected";
    }
    return "Unreachable";
  };

  return (
    <Card kicker="AI assistant" title="AI assistant (optional)">
      {status === null ? (
        <Spinner label="Checking AI status" />
      ) : (
        <>
          <p className="card-body">
            Off by default. Turn it on and connect a provider to get spending
            explanations, forecasts, and monthly summaries. The server talks to
            the provider — the desktop app never holds your key.
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              aria-hidden="true"
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: !status.enabled
                  ? "var(--color-neutral-600)"
                  : status.configured && status.reachable
                    ? "var(--color-positive)"
                    : "var(--color-negative)",
              }}
            />
            <span style={{ fontSize: 13 }}>{statusLine(status)}</span>
            {status.enabled && status.configured && (
              <Button variant="ghost" onClick={reload} style={{ marginLeft: "auto" }}>
                Test connection
              </Button>
            )}
          </div>

          {!isOwner ? (
            <p className="card-meta">Only the owner can change AI settings.</p>
          ) : (
            <>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 160 }}>
                  <Select
                    label="Provider"
                    value={provider}
                    onChange={(e) => {
                      const next = e.target.value as AiProvider;
                      setProvider(next);
                      // Reset per-provider fields to that provider's default.
                      setModel(AI_MODEL_SUGGESTIONS[next][0] ?? "");
                      if (next === "ollama" && !baseUrl.trim()) setBaseUrl("http://ollama:11434");
                      setApiKey("");
                      touch();
                    }}
                  >
                    {AiProvider.options.map((p) => (
                      <option key={p} value={p}>
                        {AI_PROVIDER_LABELS[p]}
                      </option>
                    ))}
                  </Select>
                </div>
                <div style={{ flex: 1, minWidth: 160 }}>
                  <Field
                    label="Model"
                    value={model}
                    list="ai-model-suggestions"
                    onChange={(e) => {
                      setModel(e.target.value);
                      touch();
                    }}
                    placeholder={AI_MODEL_SUGGESTIONS[provider][0]}
                  />
                  <datalist id="ai-model-suggestions">
                    {AI_MODEL_SUGGESTIONS[provider].map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </div>
              </div>

              {provider === "ollama" ? (
                <Field
                  label="Ollama base URL"
                  value={baseUrl}
                  onChange={(e) => {
                    setBaseUrl(e.target.value);
                    touch();
                  }}
                  placeholder="http://ollama:11434"
                  hint={'"ollama" is the bundled Docker service; or an address elsewhere on your network.'}
                />
              ) : (
                <Field
                  label={`${AI_PROVIDER_LABELS[provider]} API key`}
                  type="password"
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    touch();
                  }}
                  placeholder={
                    status.hasApiKey && status.provider === provider
                      ? "•••••••• (saved — leave blank to keep)"
                      : "sk-…"
                  }
                  hint={
                    status.hasApiKey && status.provider === provider ? (
                      <>
                        A key is saved.{" "}
                        <button
                          type="button"
                          onClick={() => void clearKey()}
                          style={{
                            background: "none",
                            border: 0,
                            padding: 0,
                            color: "var(--color-accent)",
                            cursor: "pointer",
                            font: "inherit",
                          }}
                        >
                          Remove it
                        </button>
                        .
                      </>
                    ) : (
                      "Stored on your server, never on this device."
                    )
                  }
                />
              )}

              {isCloud && (
                <div
                  role="note"
                  style={{
                    fontSize: 12.5,
                    lineHeight: 1.6,
                    padding: "10px 12px",
                    borderRadius: "var(--radius-md)",
                    background: "color-mix(in srgb, var(--color-negative) 10%, transparent)",
                    border: "1px solid color-mix(in srgb, var(--color-negative) 35%, transparent)",
                  }}
                >
                  <strong>Heads up:</strong> {AI_PROVIDER_LABELS[provider]} is a cloud
                  service. When you ask a question, a summary of your accounts,
                  spending, and budgets is sent to {AI_PROVIDER_LABELS[provider]} under
                  your API key. Choose Ollama to keep everything on your own hardware.
                </div>
              )}

              <label className="radio" style={{ fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => {
                    setEnabled(e.target.checked);
                    touch();
                  }}
                />
                <span className="dot" style={{ borderRadius: 4 }} />
                Enable the AI assistant
              </label>

              {error && (
                <div role="alert" style={{ fontSize: 13, color: "var(--color-negative)" }}>
                  {error}
                </div>
              )}
              <div>
                <Button variant="primary" onClick={() => void save()} disabled={!dirty || busy}>
                  {busy ? <Spinner label="Saving" /> : "Save & test"}
                </Button>
              </div>
            </>
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
