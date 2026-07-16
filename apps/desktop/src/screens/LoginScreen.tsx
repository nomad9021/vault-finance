import { ApiRequestError, type PublicProfile } from "@vault/shared";
import { Avatar, Button, Spinner } from "@vault/ui";
import { useEffect, useRef, useState } from "react";
import { useApp } from "../state/store.js";
import { AuthHeading, AuthLayout } from "./AuthLayout.js";

/**
 * Profile-picker login, following the design's login card: household member
 * bubbles, then a password field for the selected profile.
 */
export function LoginScreen() {
  const client = useApp((s) => s.client);
  const platform = useApp((s) => s.platform);
  const signedIn = useApp((s) => s.signedIn);
  const changeServer = useApp((s) => s.changeServer);
  const serverAddress = useApp((s) => s.serverAddress);

  const [profiles, setProfiles] = useState<PublicProfile[] | null>(null);
  const [selected, setSelected] = useState<PublicProfile | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .profiles()
      .then((r) => {
        if (!cancelled) setProfiles(r.profiles);
      })
      .catch(() => {
        if (!cancelled) setProfiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    if (selected) passwordRef.current?.focus();
  }, [selected]);

  const doLogin = async () => {
    if (!selected || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.login({
        userId: selected.id,
        password,
        deviceName: platform.deviceName,
        platform: platform.platformName,
      });
      signedIn(result.user);
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.code === "RATE_LIMITED"
            ? "Too many attempts — wait a few minutes and try again."
            : "That password isn't right."
          : "Lost the connection to the server.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <AuthHeading
        title="Sign in to Vault Finance"
        subtitle={serverAddress?.replace(/^https?:\/\//, "") ?? "self-hosted"}
      />

      {profiles === null ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 20 }}>
          <Spinner label="Loading profiles" />
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            gap: 10,
            justifyContent: "center",
            marginBottom: 18,
            flexWrap: "wrap",
          }}
        >
          {profiles.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                setSelected(p);
                setPassword("");
                setError(null);
              }}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
                padding: "14px 22px",
                borderRadius: 12,
                cursor: "pointer",
                background:
                  selected?.id === p.id ? "var(--color-accent-900)" : "transparent",
                border: `1px solid ${
                  selected?.id === p.id ? "var(--color-accent-600)" : "var(--color-divider)"
                }`,
                transition: "background .15s",
                font: "inherit",
              }}
            >
              <Avatar name={p.displayName} color={p.avatarColor} />
              <span style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text)" }}>
                {p.displayName.split(" ")[0]}
              </span>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void doLogin();
          }}
          style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 6 }}
        >
          <input
            ref={passwordRef}
            className="input"
            type="password"
            style={{ borderRadius: 9 }}
            placeholder={`Password for ${selected.displayName.split(" ")[0]}`}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-label="Password"
          />
          {error && (
            <div role="alert" style={{ fontSize: 12.5, color: "var(--color-negative)" }}>
              {error}
            </div>
          )}
          <Button variant="primary" block type="submit" disabled={busy || !password}>
            {busy ? <Spinner label="Signing in" /> : "Sign in"}
          </Button>
        </form>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "16px 0" }}>
        <span style={{ flex: 1, height: 1, background: "var(--color-divider)" }} />
        <span
          style={{
            fontSize: 11,
            color: "var(--color-neutral-500)",
            textTransform: "uppercase",
            letterSpacing: ".05em",
          }}
        >
          server
        </span>
        <span style={{ flex: 1, height: 1, background: "var(--color-divider)" }} />
      </div>
      <Button variant="secondary" block onClick={() => void changeServer()}>
        Connect to a different server
      </Button>
    </AuthLayout>
  );
}
