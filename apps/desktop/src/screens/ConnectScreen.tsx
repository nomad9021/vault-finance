import { Button, Field, Spinner } from "@vault/ui";
import { useState } from "react";
import { useApp } from "../state/store.js";
import { AuthHeading, AuthLayout } from "./AuthLayout.js";

export function ConnectScreen({ error }: { error?: string }) {
  const connectTo = useApp((s) => s.connectTo);
  const cancelConnect = useApp((s) => s.cancelConnect);
  const priorAddress = useApp((s) => s.priorAddress);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!address.trim() || busy) return;
    setBusy(true);
    try {
      await connectTo(address);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <AuthHeading
        title="Connect to your server"
        subtitle="Vault Finance is self-hosted — your data lives on your own hardware"
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        style={{ display: "flex", flexDirection: "column", gap: 14 }}
      >
        <Field
          label="Server address"
          placeholder="https://192.168.1.10:8443"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          autoFocus
          spellCheck={false}
          autoCapitalize="off"
          error={error}
          hint="LAN IP, hostname, or Tailscale address of the machine running your server."
        />
        <Button variant="primary" block type="submit" disabled={busy || !address.trim()}>
          {busy ? <Spinner label="Connecting" /> : "Connect"}
        </Button>
        {priorAddress && (
          <Button
            variant="secondary"
            block
            type="button"
            disabled={busy}
            onClick={() => void cancelConnect()}
          >
            Cancel
          </Button>
        )}
      </form>
      <div className="text-muted" style={{ fontSize: 12, marginTop: 16, lineHeight: 1.6 }}>
        Don't have a server yet? The self-hosting guide walks through starting
        one with Docker Compose in a few minutes.
      </div>
    </AuthLayout>
  );
}
