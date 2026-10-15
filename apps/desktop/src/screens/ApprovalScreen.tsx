import { ApiRequestError } from "@vault/shared";
import { Button, Spinner } from "@vault/ui";
import { useEffect, useRef, useState } from "react";
import { currentDeviceIdentity, useApp } from "../state/store.js";
import { AppMark, AuthLayout } from "./AuthLayout.js";

const POLL_MS = 3_000;

/**
 * Password was right, but this device isn't approved yet (ADR-0009). Show the
 * code to match and wait — the device signs itself in once someone approves
 * it on a trusted device or on the server console.
 */
export function ApprovalScreen() {
  const screen = useApp((s) => s.screen);
  const client = useApp((s) => s.client);
  const serverAddress = useApp((s) => s.serverAddress);
  const signedIn = useApp((s) => s.signedIn);
  const [left, setLeft] = useState<number>(0);
  const [problem, setProblem] = useState<string | null>(null);
  const stopped = useRef(false);

  const challenge = screen.name === "approval" ? screen.challenge : null;
  const toLogin = (notice?: string) =>
    useApp.setState({ screen: { name: "login", ...(notice ? { notice } : {}) } });

  useEffect(() => {
    if (!challenge) return;
    stopped.current = false;
    const tick = async () => {
      if (stopped.current) return;
      const id = currentDeviceIdentity();
      if (!id) {
        setProblem("This device's identity couldn't be loaded. Go back and sign in again.");
        return;
      }
      try {
        const r = await client.deviceApprovalStatus({ approvalId: challenge.approvalId, ...id });
        if (stopped.current) return;
        if (r.status === "approved") {
          signedIn(r.login.user);
          return;
        }
        if (r.status === "denied") return toLogin("This device wasn't approved. Ask the person who manages the server.");
        if (r.status === "expired") return toLogin("The approval request timed out. Sign in again to get a new code.");
        setProblem(null);
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404) {
          return toLogin("The approval request is no longer valid. Sign in again.");
        }
        setProblem("Can't reach the server right now — still trying.");
      }
      setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      stopped.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challenge?.approvalId]);

  useEffect(() => {
    if (!challenge) return;
    const update = () => setLeft(Math.max(0, Math.round((Date.parse(challenge.expiresAt) - Date.now()) / 1000)));
    update();
    const t = setInterval(update, 1_000);
    return () => clearInterval(t);
  }, [challenge]);

  if (!challenge) return null;
  const methods = challenge.methods.split(",");
  const code = `${challenge.code.slice(0, 3)} ${challenge.code.slice(3)}`;
  const host = serverAddress ? new URL(serverAddress).hostname : "the server";

  return (
    <AuthLayout width={460}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <AppMark size={34} />
        <div>
          <div style={{ fontWeight: 700, fontSize: "var(--text-lg)" }}>Approve this device</div>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--content-tertiary)" }}>
            Signing in as {screen.name === "approval" ? screen.userName : ""} · new device
          </div>
        </div>
      </div>
      <p style={{ fontSize: "var(--text-sm)", lineHeight: 1.6, margin: "0 0 14px" }}>
        Your password was right. Because this device hasn't been used with this server before, it has to be
        let in first. Use this code:
      </p>
      <div
        aria-label={`Approval code ${challenge.code.split("").join(" ")}`}
        style={{
          fontFamily: "ui-monospace, monospace",
          fontSize: 40,
          fontWeight: 700,
          letterSpacing: "0.12em",
          textAlign: "center",
          padding: "14px 0",
          borderRadius: "var(--radius-md)",
          background: "var(--color-bg)",
          border: "1px solid var(--color-divider)",
        }}
      >
        {code}
      </div>
      <ol style={{ fontSize: "var(--text-sm)", lineHeight: 1.6, paddingLeft: 20, margin: "14px 0" }}>
        {methods.includes("trustedDevice") && (
          <li>
            <strong>On a device that's already signed in</strong>, a “New sign-in” prompt appears (or open
            Settings → Devices). Type the code above and choose Allow.
          </li>
        )}
        {methods.includes("serverConsole") && (
          <li>
            <strong>Or on the server</strong> ({host}), run:
            <div
              style={{
                fontFamily: "ui-monospace, monospace",
                fontSize: "var(--text-xs)",
                background: "var(--color-bg)",
                border: "1px solid var(--color-divider)",
                borderRadius: "var(--radius-sm)",
                padding: "6px 8px",
                marginTop: 4,
                userSelect: "all",
              }}
            >
              docker compose exec server vault approve {challenge.code}
            </div>
          </li>
        )}
      </ol>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Spinner label="Waiting for approval" />
        <span style={{ fontSize: "var(--text-sm)", color: "var(--content-secondary)", flex: 1 }}>
          {problem ?? `Waiting… this code works for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}
        </span>
        <Button variant="secondary" onClick={() => toLogin()}>
          Cancel
        </Button>
      </div>
    </AuthLayout>
  );
}

