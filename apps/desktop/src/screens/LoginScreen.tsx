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
  const [needsTotp, setNeedsTotp] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const totpRef = useRef<HTMLInputElement>(null);

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
  useEffect(() => {
    if (needsTotp) totpRef.current?.focus();
  }, [needsTotp]);

  const doLogin = async () => {
    if (!selected || !password || busy) return;
    if (needsTotp && totpCode.replace(/\s/g, "").length < 6) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.login({
        userId: selected.id,
        password,
        deviceName: platform.deviceName,
        platform: platform.platformName,
        ...(needsTotp && totpCode ? { totpCode: totpCode.replace(/\s/g, "") } : {}),
      });
      signedIn(result.user);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === "TOTP_REQUIRED") {
        // Password was right; now ask for the authenticator code.
        setNeedsTotp(true);
        setError(null);
      } else if (err instanceof ApiRequestError && err.code === "TOTP_INVALID") {
        setNeedsTotp(true);
        setError("That authentication code isn't right — try the current one.");
      } else {
        setNeedsTotp(false);
        setError(
          err instanceof ApiRequestError
            ? err.code === "RATE_LIMITED"
              ? "Too many attempts — wait a few minutes and try again."
              : "That password isn't right."
            : "Lost the connection to the server.",
        );
      }
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
                setNeedsTotp(false);
                setTotpCode("");
                setError(null);
              }}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
                padding: "14px 22px",
                borderRadius: "var(--radius-lg)",
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
              <span style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--color-text)" }}>
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
            style={{ borderRadius: "var(--radius-md)" }}
            placeholder={`Password for ${selected.displayName.split(" ")[0]}`}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-label="Password"
            readOnly={needsTotp}
          />
          {needsTotp && (
            <>
              <input
                ref={totpRef}
                className="input"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                style={{ borderRadius: "var(--radius-md)", letterSpacing: "0.3em", textAlign: "center", fontVariantNumeric: "tabular-nums" }}
                placeholder="6-digit code"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/[^0-9]/g, ""))}
                aria-label="Authentication code"
              />
              <div style={{ fontSize: "var(--text-xs)", color: "var(--content-tertiary)", lineHeight: 1.5 }}>
                Enter the current 6-digit code from your authenticator app.
              </div>
            </>
          )}
          {error && (
            <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--color-negative)" }}>
              {error}
            </div>
          )}
          <Button
            variant="primary"
            block
            type="submit"
            disabled={busy || !password || (needsTotp && totpCode.length < 6)}
          >
            {busy ? <Spinner label="Signing in" /> : needsTotp ? "Verify & sign in" : "Sign in"}
          </Button>
        </form>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "16px 0" }}>
        <span style={{ flex: 1, height: 1, background: "var(--color-divider)" }} />
        <span
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--content-tertiary)",
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
