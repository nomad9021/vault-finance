import { ApiRequestError, type PublicProfile } from "@vault/shared";
import { Avatar, Button, Spinner } from "@vault/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../state/store.js";
import { AuthHeading, AuthLayout } from "./AuthLayout.js";

/**
 * Profile-picker login, following the design's login card: household member
 * bubbles, then a password field for the selected profile. Profiles enrolled
 * for biometric sign-in on this device get a Windows Hello / Touch ID /
 * fingerprint button, prompted automatically when the app opens locked.
 */
export function LoginScreen() {
  const client = useApp((s) => s.client);
  const platform = useApp((s) => s.platform);
  const signedIn = useApp((s) => s.signedIn);
  const changeServer = useApp((s) => s.changeServer);
  const serverAddress = useApp((s) => s.serverAddress);
  const lockedUser = useApp((s) => s.lockedUser);
  const biometric = useApp((s) => s.biometric);
  const biometricUserIds = useApp((s) => s.biometricUserIds);
  const unlockWithBiometric = useApp((s) => s.unlockWithBiometric);

  const [profiles, setProfiles] = useState<PublicProfile[] | null>(null);
  const [householdName, setHouseholdName] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [selected, setSelected] = useState<PublicProfile | null>(null);
  const [password, setPassword] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [busy, setBusy] = useState(false);
  // A message carried over from the approval screen (denied / expired).
  const notice = useApp((s) => (s.screen.name === "login" ? (s.screen.notice ?? null) : null));
  const [error, setError] = useState<string | null>(notice);
  const passwordRef = useRef<HTMLInputElement>(null);
  const totpRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .profiles()
      .then((r) => {
        if (cancelled) return;
        setProfiles(r.profiles);
        setHouseholdName(r.householdName ?? null);
        // Opened locked: start on the saved session's profile.
        const locked = lockedUser && r.profiles.find((p) => p.id === lockedUser.id);
        if (locked) setSelected(locked);
      })
      .catch(() => {
        if (!cancelled) setProfiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  // The automatic Face ID attempt may retry only until the person takes over.
  const autoActive = useRef(true);
  const bioLabel = biometric?.label ?? "biometrics";
  const selectedHasBiometric = !!selected && biometricUserIds.includes(selected.id);

  const doBiometric = useCallback(
    async (profile: PublicProfile) => {
      // A tap always works: it takes over from the automatic attempt.
      autoActive.current = false;
      if (busy) return;
      setScanning(true);
      setError(null);
      try {
        const r = await unlockWithBiometric(profile.id);
        if (!r.ok && r.reason !== "cancelled" && r.reason !== "interrupted") {
          setError(
            r.message ??
              (r.reason === "failed"
                ? `${bioLabel} didn't recognize you — try again or use your password.`
                : `${bioLabel} isn't available right now — use your password.`),
          );
        }
      } finally {
        setScanning(false);
      }
    },
    [busy, unlockWithBiometric, bioLabel],
  );

  // Locked with Face ID / Touch ID set up for this profile: ask for it
  // straight away. Coming back to the app after leaving it (iPhone swipe
  // away), that happens behind a blank padlock page; recognised = straight
  // back in. A failed match, a cancel, or 4 seconds without getting in shows
  // the sign-in page. Any other lock (fresh start, Ctrl/Cmd+L, idle) shows the
  // sign-in page from the start, with the prompt on top of it.
  const lockedAway = useApp((s) => s.lockedAway);
  const biometricFirst = !!lockedUser && biometricUserIds.includes(lockedUser.id);
  const faceIdFirst = biometricFirst && lockedAway;
  const [veilLifted, setVeilLifted] = useState(false);
  useEffect(() => {
    if (!faceIdFirst || veilLifted) return;
    const t = setTimeout(() => {
      autoActive.current = false;
      setScanning(false);
      setVeilLifted(true);
    }, 4000);
    return () => clearTimeout(t);
  }, [faceIdFirst, veilLifted]);
  const autoPrompted = useRef(false);
  // "Still on screen", kept apart from the prompt effect: that effect may
  // re-run (e.g. once the Face ID label loads) and must not drop a result.
  const onScreen = useRef(true);
  useEffect(() => {
    onScreen.current = true;
    return () => {
      onScreen.current = false;
    };
  }, []);
  const labelRef = useRef(bioLabel);
  labelRef.current = bioLabel;
  useEffect(() => {
    if (autoPrompted.current || !biometricFirst || !lockedUser) return;
    autoPrompted.current = true;
    // Ask only once the app is in front (iOS refuses Face ID while it's
    // leaving or away). If leaving the app interrupted the prompt, keep the
    // padlock and ask again on return; only a real cancel or a failed match
    // brings up the sign-in page.
    let tries = 0;
    const attempt = async (): Promise<Awaited<ReturnType<typeof unlockWithBiometric>>> => {
      // A retry pauses briefly, so a prompt the system keeps refusing can't spin.
      if (tries++ > 0) await new Promise((r) => setTimeout(r, 400));
      await platform.whenActive?.();
      if (!onScreen.current || !autoActive.current) return { ok: false, reason: "cancelled" };
      const r = await unlockWithBiometric(lockedUser.id);
      // Interrupted by the system (or a cancel that landed as the app left):
      // keep the padlock up and ask again once the app is back in front.
      const interrupted =
        !r.ok &&
        (r.reason === "interrupted" || (r.reason === "cancelled" && !!platform.isActive && !platform.isActive()));
      if (interrupted && onScreen.current && autoActive.current && tries < 3) {
        return attempt();
      }
      return r;
    };
    setScanning(true);
    void attempt()
      .then((r) => {
        // The person took over (tapped the button, or the 4 seconds passed):
        // leave the result of this attempt alone.
        if (r.ok || !onScreen.current || !autoActive.current) return;
        setVeilLifted(true);
        if (r.reason !== "cancelled" && r.reason !== "interrupted") {
          setError(
            r.message ??
              (r.reason === "failed"
                ? `${labelRef.current} didn't recognize you — try again or use your password.`
                : `${labelRef.current} isn't available right now — use your password.`),
          );
        }
      })
      .catch(() => setVeilLifted(true))
      .finally(() => {
        if (autoActive.current) setScanning(false);
      });
  }, [biometricFirst, lockedUser, unlockWithBiometric, platform]);

  useEffect(() => {
    if (selected && !biometricUserIds.includes(selected.id)) passwordRef.current?.focus();
  }, [selected, biometricUserIds]);
  useEffect(() => {
    if (needsTotp) totpRef.current?.focus();
  }, [needsTotp]);

  const doLogin = async () => {
    if (!selected || !password || busy) return;
    if (needsTotp && totpCode.replace(/\s/g, "").length < 6) return;
    setBusy(true);
    setError(null);
    try {
      // Opened locked and choosing the password route: end the saved session
      // first so it doesn't linger as an orphan device.
      if (lockedUser) await client.logout();
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
      } else if (err instanceof ApiRequestError && useApp.getState().awaitApproval(err, selected.displayName)) {
        // Password was right; the approval screen takes over from here.
      } else if (err instanceof ApiRequestError && err.code === "DEVICE_NOT_TRUSTED") {
        setNeedsTotp(false);
        setError(err.message);
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

  if (faceIdFirst && !veilLifted) return <LockVeil />;

  return (
    <AuthLayout>
      <AuthHeading
        title={householdName ?? "Vault Finance"}
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
                if (biometricUserIds.includes(p.id)) void doBiometric(p);
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
              <Avatar name={p.displayName} color={p.avatarColor} image={p.avatarImage ?? null} />
              <span style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--color-text)" }}>
                {p.displayName.split(" ")[0]}
              </span>
            </button>
          ))}
        </div>
      )}

      {selected && selectedHasBiometric && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
          <Button
            variant="primary"
            block
            icon={bioLabel === "Windows Hello" ? "user" : "fingerprint"}
            onClick={() => void doBiometric(selected)}
            disabled={scanning || busy}
          >
            {scanning ? <Spinner label={`Waiting for ${bioLabel}`} /> : `Sign in with ${bioLabel}`}
          </Button>
          {scanning && bioLabel === "Fingerprint" && (
            <div className="row" style={{ justifyContent: "center", gap: 8, fontSize: "var(--text-xs)", color: "var(--content-tertiary)" }}>
              Touch the fingerprint reader…
              <Button variant="ghost" onClick={() => void platform.biometricCancel()}>
                Cancel
              </Button>
            </div>
          )}
          {!scanning && (
            <div style={{ textAlign: "center", fontSize: "var(--text-2xs)", color: "var(--content-tertiary)", textTransform: "uppercase", letterSpacing: ".05em" }}>
              or use your password
            </div>
          )}
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
            variant={selectedHasBiometric ? "secondary" : "primary"}
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

/**
 * Locked, waiting on Face ID: an empty page with the padlock, nothing else
 * (no names, no text), so a glance at the phone gives nothing away.
 */
function LockVeil() {
  return (
    <div className="lock-veil" role="img" aria-label="Vault Finance is locked">
      <img src="/padlock.png" alt="" className="lock-veil-mark" />
    </div>
  );
}
