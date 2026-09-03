import { ErrorBoundary, Button, Card, Field, Spinner, Tag } from "@vault/ui";
import type { ControlFamily } from "@vault/shared";
import { useCallback, useEffect, useState } from "react";
import {
  clearConnection,
  control,
  loadConnection,
  probeAndTrust,
  saveConnection,
  trust,
  type ControlConnection,
} from "./control.js";

export function AdminApp() {
  const [conn, setConn] = useState<ControlConnection | null | undefined>(undefined);

  useEffect(() => {
    void loadConnection().then((c) => setConn(c));
  }, []);

  return (
    <div className="page" style={{ maxWidth: 860, paddingTop: 32 }}>
      <h1 style={{ fontSize: "var(--text-2xl)", marginBottom: 4 }}>Server administration</h1>
      <p className="card-meta" style={{ marginBottom: 24 }}>
        Manage the family instances hosted on this server. This window is separate
        from the app and only you (the operator) should use it.
      </p>
      <ErrorBoundary resetKeys={[conn ? conn.url : "none"]}>
        {conn === undefined ? (
          <Spinner label="Loading" />
        ) : conn === null ? (
          <ConnectForm onConnected={setConn} />
        ) : (
          <Console
            conn={conn}
            onDisconnect={async () => {
              await clearConnection();
              setConn(null);
            }}
          />
        )}
      </ErrorBoundary>
    </div>
  );
}

function ConnectForm({ onConnected }: { onConnected: (c: ControlConnection) => void }) {
  const [url, setUrl] = useState("https://");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ fingerprint?: string } | null>(null);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const trimmed = url.trim().replace(/\/+$/, "");
      const probe = await probeAndTrust(trimmed);
      if (!probe.trusted) {
        setPending({ ...(probe.fingerprint ? { fingerprint: probe.fingerprint } : {}) });
        setBusy(false);
        return;
      }
      const conn = { url: trimmed, token: token.trim() };
      await control.families(conn); // verifies the token
      await saveConnection(conn);
      onConnected(conn);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect.");
      setBusy(false);
    }
  };

  const trustAndRetry = async () => {
    await trust(url.trim().replace(/\/+$/, ""), pending?.fingerprint ?? null);
    setPending(null);
    await connect();
  };

  return (
    <Card kicker="Connect" title="Admin control-plane">
      <p className="card-body">
        Run <code>familyctl.sh up</code> with <code>CONTROL=1</code> on the host — it
        prints the admin console URL and token.
      </p>
      <div style={{ display: "grid", gap: 12, maxWidth: 420 }}>
        <Field label="Control-plane URL" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://server:9443" />
        <Field label="Admin token" type="password" value={token} onChange={(e) => setToken(e.target.value)} />
        {error && (
          <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--color-negative)" }}>
            {error}
          </div>
        )}
        {pending ? (
          <div style={{ display: "grid", gap: 8 }}>
            <p className="card-meta" style={{ margin: 0 }}>
              First connection — confirm this certificate fingerprint matches what the
              host printed:
            </p>
            <code style={{ fontSize: "var(--text-2xs)", wordBreak: "break-all", userSelect: "all" }}>
              {pending.fingerprint ?? "(unavailable)"}
            </code>
            <div style={{ display: "flex", gap: 8 }}>
              <Button variant="primary" onClick={() => void trustAndRetry()}>
                Trust &amp; connect
              </Button>
              <Button variant="ghost" onClick={() => setPending(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="primary" onClick={() => void connect()} disabled={busy || !token.trim()}>
            {busy ? <Spinner label="Connecting" /> : "Connect"}
          </Button>
        )}
      </div>
    </Card>
  );
}

function Console({ conn, onDisconnect }: { conn: ControlConnection; onDisconnect: () => void }) {
  const [families, setFamilies] = useState<ControlFamily[] | null>(null);
  const [latest, setLatest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const reload = useCallback(() => {
    setError(null);
    control
      .families(conn)
      .then((r) => {
        setFamilies(r.families);
        setLatest(r.latestVersion);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load."));
  }, [conn]);
  useEffect(reload, [reload]);

  const runUpdate = async (slug: string) => {
    setLog(`Updating ${slug}…`);
    try {
      const r = await control.updateFamily(conn, slug);
      setLog(r.log.trim() || "done");
    } catch (e) {
      setLog(e instanceof Error ? e.message : "update failed");
    }
    reload();
  };

  const runDestroy = async (slug: string) => {
    if (!confirm(`Permanently remove "${slug}"? Its data is archived to the host's backups first.`)) return;
    setLog(`Removing ${slug}…`);
    try {
      const r = await control.destroyFamily(conn, slug);
      setLog(r.log.trim() || "done");
    } catch (e) {
      setLog(e instanceof Error ? e.message : "remove failed");
    }
    reload();
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Card kicker="Households" title="Hosted families">
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <Button variant="secondary" onClick={() => setAdding(true)}>
            Add household
          </Button>
          <Button variant="ghost" onClick={reload}>
            Refresh
          </Button>
        </div>
        {latest && <p className="card-meta">Latest release: v{latest}</p>}
        {error && (
          <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--color-negative)" }}>
            {error}
          </div>
        )}
        {families === null ? (
          <Spinner label="Loading families" />
        ) : families.length === 0 ? (
          <p className="card-body">No families yet. Add one to get started.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Slug</th>
                <th>Address</th>
                <th>State</th>
                <th>Version</th>
                <th>Owner</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {families.map((f) => {
                const behind = f.runningVersion && latest && f.runningVersion !== latest;
                return (
                  <tr key={f.slug}>
                    <td>{f.slug}</td>
                    <td style={{ fontFamily: "ui-monospace, monospace", fontSize: "var(--text-xs)" }}>
                      {f.appPublicUrl ?? (f.mode === "proxy" ? f.domain : `:${f.port}`)}
                    </td>
                    <td>
                      {f.state === "running" ? (
                        <Tag variant="accent">running</Tag>
                      ) : (
                        <Tag>{f.state}</Tag>
                      )}
                    </td>
                    <td>
                      {f.runningVersion ?? "—"}{" "}
                      {behind && <Tag>update</Tag>}
                    </td>
                    <td style={{ fontSize: "var(--text-xs)" }}>{f.ownerEmail ?? "—"}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <Button variant="ghost" onClick={() => void runUpdate(f.slug)}>
                        Update
                      </Button>
                      <Button variant="ghost" onClick={() => void runDestroy(f.slug)}>
                        Remove
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {log && (
          <pre
            style={{
              marginTop: 12,
              maxHeight: 200,
              overflow: "auto",
              background: "var(--color-neutral-900)",
              borderRadius: 8,
              padding: 12,
              fontSize: "var(--text-2xs)",
              whiteSpace: "pre-wrap",
            }}
          >
            {log}
          </pre>
        )}
      </Card>

      {adding && (
        <AddHousehold
          conn={conn}
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            reload();
          }}
          onLog={setLog}
        />
      )}

      <div style={{ textAlign: "center" }}>
        <button
          onClick={onDisconnect}
          style={{
            background: "none",
            border: 0,
            color: "var(--content-tertiary)",
            font: "inherit",
            fontSize: "var(--text-xs)",
            textDecoration: "underline",
            cursor: "pointer",
          }}
        >
          Disconnect this admin window
        </button>
      </div>
    </div>
  );
}

function AddHousehold({
  conn,
  onClose,
  onCreated,
  onLog,
}: {
  conn: ControlConnection;
  onClose: () => void;
  onCreated: () => void;
  onLog: (s: string) => void;
}) {
  const [slug, setSlug] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [mode, setMode] = useState<"port" | "proxy">("port");
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await control.createFamily(conn, {
        slug: slug.trim(),
        ...(ownerEmail.trim() ? { ownerEmail: ownerEmail.trim() } : {}),
        mode,
        ...(mode === "proxy" ? { domain: domain.trim() } : {}),
      });
      onLog(
        `Created "${res.slug}". Connect address: ${res.connectUrl}` +
          (res.welcomeEmailSent ? " — welcome email sent." : "."),
      );
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed.");
      setBusy(false);
    }
  };

  return (
    <Card kicker="New" title="Add a household">
      <div style={{ display: "grid", gap: 12, maxWidth: 420 }}>
        <Field
          label="Slug (lowercase, e.g. smith)"
          value={slug}
          onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, ""))}
          autoFocus
        />
        <Field
          label="Owner email (for the welcome + survey)"
          type="email"
          value={ownerEmail}
          onChange={(e) => setOwnerEmail(e.target.value)}
        />
        <label style={{ fontSize: "var(--text-sm)" }}>
          Access mode
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as "port" | "proxy")}
            style={{ display: "block", marginTop: 4, padding: "8px 10px", width: "100%" }}
          >
            <option value="port">Port on the LAN (default)</option>
            <option value="proxy">Subdomain via HAProxy</option>
          </select>
        </label>
        {mode === "proxy" && (
          <Field
            label="Domain (e.g. smith.vault.example.com)"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
        )}
        {error && (
          <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--color-negative)" }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="primary" onClick={() => void create()} disabled={busy || !slug.trim()}>
            {busy ? <Spinner label="Creating" /> : "Create household"}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}
