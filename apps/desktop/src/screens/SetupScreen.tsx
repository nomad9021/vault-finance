import { ApiRequestError } from "@vault/shared";
import { Button, Field, Spinner } from "@vault/ui";
import { useState } from "react";
import { useApp } from "../state/store.js";
import { AuthHeading, AuthLayout } from "./AuthLayout.js";

/**
 * First-run setup: create the owner account. That's it — the AI assistant is
 * off by default and configured later in Settings, so setup is a single step.
 */
export function SetupScreen() {
  const client = useApp((s) => s.client);
  const routeForServer = useApp((s) => s.routeForServer);

  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const valid =
    displayName.trim() &&
    /.+@.+\..+/.test(email) &&
    password.length >= 10 &&
    password === confirm;

  const finish = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.setupComplete({
        ownerEmail: email,
        ownerPassword: password,
        ownerDisplayName: displayName.trim(),
      });
      await routeForServer(); // server now reports needsSetup=false → login
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setError(err.message);
        setFieldErrors(err.fields ?? {});
      } else {
        setError("Could not reach the server. Is it still running?");
      }
      setBusy(false);
    }
  };

  return (
    <AuthLayout width={420}>
      <AuthHeading title="Set up your server" subtitle="Create your owner account" />
      <form
        style={{ display: "flex", flexDirection: "column", gap: 14 }}
        onSubmit={(e) => {
          e.preventDefault();
          void finish();
        }}
      >
        <Field
          label="Your name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          autoFocus
          error={fieldErrors["ownerDisplayName"]}
        />
        <Field
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          hint="Used to sign in — nothing is ever emailed anywhere."
          error={fieldErrors["ownerEmail"]}
        />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint="At least 10 characters. A few random words work well."
          error={fieldErrors["ownerPassword"]}
        />
        <Field
          label="Confirm password"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={confirm && confirm !== password ? "Passwords don't match." : undefined}
        />
        <p className="text-muted" style={{ fontSize: "var(--text-xs)", lineHeight: 1.6, margin: 0 }}>
          The AI assistant is off by default. You can connect a provider later
          in Settings if you want it.
        </p>
        {error && (
          <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--color-negative)" }}>
            {error}
          </div>
        )}
        <Button variant="primary" block type="submit" disabled={!valid || busy}>
          {busy ? <Spinner label="Setting up" /> : "Finish setup"}
        </Button>
      </form>
    </AuthLayout>
  );
}
