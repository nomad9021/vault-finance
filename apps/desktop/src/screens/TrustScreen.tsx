import { Button } from "@vault/ui";
import { useState } from "react";
import type { ProbeResult } from "../platform/index.js";
import { useApp } from "../state/store.js";
import { AuthHeading, AuthLayout } from "./AuthLayout.js";

/** Group a hex fingerprint into readable pairs, SSH-style. */
function formatFingerprint(hex: string): string {
  return (hex.match(/.{1,2}/g) ?? []).join(":").toUpperCase();
}

/**
 * Trust-On-First-Use confirmation (ADR-0004). Shown only when the server's
 * certificate isn't OS-trusted and no pin exists yet for this address.
 */
export function TrustScreen({ address, probe }: { address: string; probe: ProbeResult }) {
  const confirmTrust = useApp((s) => s.confirmTrust);
  const declineTrust = useApp((s) => s.declineTrust);
  const [busy, setBusy] = useState(false);

  return (
    <AuthLayout width={440}>
      <AuthHeading title="Verify server identity" subtitle={address} />
      <p style={{ fontSize: 13.5, lineHeight: 1.6 }}>
        This server uses a self-signed certificate. Compare the fingerprint
        below with the one your server prints — run{" "}
        <code style={{ fontSize: 12.5 }}>docker compose logs server | grep -i fingerprint</code>{" "}
        on the server machine. If they match, it's safe to continue; Vault
        Finance will remember it and warn you if it ever changes.
      </p>
      <div
        style={{
          fontFamily: "ui-monospace, monospace",
          fontSize: 13,
          lineHeight: 1.7,
          wordBreak: "break-all",
          padding: "12px 14px",
          borderRadius: "var(--radius-md)",
          background: "var(--color-bg)",
          border: "1px solid var(--color-divider)",
          margin: "14px 0",
        }}
      >
        SHA-256
        <br />
        {probe.fingerprint ? formatFingerprint(probe.fingerprint) : "(unavailable)"}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Button variant="secondary" onClick={() => declineTrust()}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={busy || !probe.fingerprint}
          onClick={async () => {
            setBusy(true);
            try {
              await confirmTrust();
            } finally {
              setBusy(false);
            }
          }}
        >
          The fingerprints match — trust this server
        </Button>
      </div>
    </AuthLayout>
  );
}
