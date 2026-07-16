import { ApiRequestError } from "@vault/shared";
import { Button, Field, Spinner } from "@vault/ui";
import { useState } from "react";
import { useApp } from "../state/store.js";
import { AuthHeading, AuthLayout } from "./AuthLayout.js";

/**
 * First-run setup wizard: owner account, then optional AI configuration.
 * Two steps, matching the server's single /setup/complete call at the end.
 */
export function SetupScreen() {
  const client = useApp((s) => s.client);
  const routeForServer = useApp((s) => s.routeForServer);

  const [step, setStep] = useState<1 | 2>(1);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const [aiEnabled, setAiEnabled] = useState(true);
  const [ollamaHost, setOllamaHost] = useState("ollama");
  const [ollamaPort, setOllamaPort] = useState("11434");
  const [modelName, setModelName] = useState("llama3.1:8b");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const step1Valid =
    displayName.trim() &&
    /.+@.+\..+/.test(email) &&
    password.length >= 10 &&
    password === confirm;

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.setupComplete({
        ownerEmail: email,
        ownerPassword: password,
        ownerDisplayName: displayName.trim(),
        ...(aiEnabled
          ? {
              aiConfig: {
                ollamaHost: ollamaHost.trim(),
                ollamaPort: Number(ollamaPort) || 11434,
                modelName: modelName.trim(),
                enabled: true,
              },
            }
          : {
              aiConfig: {
                ollamaHost: ollamaHost.trim() || "ollama",
                ollamaPort: Number(ollamaPort) || 11434,
                modelName: modelName.trim() || "llama3.1:8b",
                enabled: false,
              },
            }),
      });
      await routeForServer(); // server now reports needsSetup=false → login
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setError(err.message);
        setFieldErrors(err.fields ?? {});
        if (err.fields && Object.keys(err.fields).some((k) => k.startsWith("owner"))) {
          setStep(1);
        }
      } else {
        setError("Could not reach the server. Is it still running?");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout width={420}>
      <AuthHeading
        title="Set up your server"
        subtitle={`Step ${step} of 2 · ${step === 1 ? "Owner account" : "AI assistant"}`}
      />

      {step === 1 ? (
        <form
          style={{ display: "flex", flexDirection: "column", gap: 14 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (step1Valid) setStep(2);
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
          <Button variant="primary" block type="submit" disabled={!step1Valid}>
            Continue
          </Button>
        </form>
      ) : (
        <form
          style={{ display: "flex", flexDirection: "column", gap: 14 }}
          onSubmit={(e) => {
            e.preventDefault();
            void finish();
          }}
        >
          <label className="radio">
            <input
              type="checkbox"
              checked={aiEnabled}
              onChange={(e) => setAiEnabled(e.target.checked)}
            />
            <span className="dot" style={{ borderRadius: 4 }} />
            Enable the AI assistant (local Ollama — never a cloud API)
          </label>
          {aiEnabled && (
            <>
              <Field
                label="Ollama host"
                value={ollamaHost}
                onChange={(e) => setOllamaHost(e.target.value)}
                hint={'"ollama" is the bundled Docker service; or an IP elsewhere on your network.'}
              />
              <div style={{ display: "flex", gap: 10 }}>
                <div style={{ width: 120 }}>
                  <Field
                    label="Port"
                    inputMode="numeric"
                    value={ollamaPort}
                    onChange={(e) => setOllamaPort(e.target.value.replace(/\D/g, ""))}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <Field
                    label="Model"
                    value={modelName}
                    onChange={(e) => setModelName(e.target.value)}
                  />
                </div>
              </div>
            </>
          )}
          <div className="text-muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
            You can change all of this later in Settings. If Ollama isn't
            reachable, everything except the assistant keeps working.
          </div>
          {error && (
            <div role="alert" style={{ fontSize: 13, color: "var(--color-negative)" }}>
              {error}
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="secondary" onClick={() => setStep(1)} disabled={busy}>
              Back
            </Button>
            <Button variant="primary" type="submit" disabled={busy} style={{ flex: 1 }}>
              {busy ? <Spinner label="Setting up" /> : "Finish setup"}
            </Button>
          </div>
        </form>
      )}
    </AuthLayout>
  );
}
