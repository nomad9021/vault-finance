import { ApiRequestError, type PendingApproval } from "@vault/shared";
import { Button, Dialog, Field, Spinner } from "@vault/ui";
import { useCallback, useEffect, useState } from "react";
import { useApp } from "../../state/store.js";

const POLL_MS = 10_000;

const PLATFORM_LABEL: Record<string, string> = { windows: "Windows", macos: "Mac", linux: "Linux", ios: "phone" };

export function describeRequest(p: PendingApproval): string {
  const when = new Date(p.requestedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${p.userDisplayName} · ${p.deviceName} (${PLATFORM_LABEL[p.platform] ?? p.platform})${
    p.ipAddress ? ` · from ${p.ipAddress}` : ""
  } · ${when}`;
}

/**
 * The "approve" step itself: type the code the new device shows (number
 * matching, so a blind "Allow" can't let an attacker in), then Allow or Deny.
 */
export function ApproveDialog({
  request,
  onDone,
}: {
  request: PendingApproval | null;
  onDone: (outcome: "approved" | "denied" | "dismissed") => void;
}) {
  const client = useApp((s) => s.client);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCode("");
    setError(null);
  }, [request?.id]);

  if (!request) return null;
  const digits = code.replace(/\D/g, "");

  const approve = async () => {
    if (digits.length !== 6 || busy) return;
    setBusy("approve");
    setError(null);
    try {
      await client.approveDevice(request.id, digits);
      onDone("approved");
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't reach the server.");
      if (err instanceof ApiRequestError && err.status === 404) onDone("dismissed");
    } finally {
      setBusy(null);
    }
  };
  const deny = async () => {
    setBusy("deny");
    try {
      await client.denyDevice(request.id);
    } catch {
      /* already gone — nothing to deny */
    } finally {
      setBusy(null);
      onDone("denied");
    }
  };

  return (
    <Dialog
      open
      title="New sign-in waiting for approval"
      onClose={() => onDone("dismissed")}
      actions={
        <>
          <Button variant="ghost" onClick={() => onDone("dismissed")} disabled={busy !== null}>
            Later
          </Button>
          <Button variant="secondary" onClick={() => void deny()} disabled={busy !== null}>
            {busy === "deny" ? <Spinner label="Denying" /> : "Deny"}
          </Button>
          <Button variant="primary" onClick={() => void approve()} disabled={busy !== null || digits.length !== 6}>
            {busy === "approve" ? <Spinner label="Approving" /> : "Allow"}
          </Button>
        </>
      }
    >
      <p style={{ margin: "0 0 10px", lineHeight: 1.6 }}>{describeRequest(request)}</p>
      <p style={{ margin: "0 0 12px", lineHeight: 1.6, fontSize: "var(--text-sm)", color: "var(--content-secondary)" }}>
        Only allow it if you know who this is. Type the 6-digit code shown on that device — if there's no code in
        front of you, it isn't you: choose <strong>Deny</strong>.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void approve();
        }}
      >
        <Field
          label="Code shown on the new device"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123 456"
          autoFocus
          error={error ?? undefined}
        />
      </form>
    </Dialog>
  );
}

/**
 * Watches for sign-ins waiting on approval while you're signed in, and pops
 * the approve dialog — like a "Is this you signing in?" prompt.
 */
export function DeviceApprovalPrompt() {
  const client = useApp((s) => s.client);
  const [queue, setQueue] = useState<PendingApproval[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [enabled, setEnabled] = useState(true);

  const check = useCallback(async () => {
    try {
      const [{ approvals }, methods] = await Promise.all([client.pendingApprovals(), client.deviceApprovalSettings()]);
      setEnabled(methods.trustedDevice);
      setQueue(approvals);
    } catch {
      // Older server or offline — try again next tick.
    }
  }, [client]);

  useEffect(() => {
    void check();
    const t = setInterval(() => void check(), POLL_MS);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [check]);

  const next = enabled ? (queue.find((r) => !dismissed.has(r.id)) ?? null) : null;
  return (
    <ApproveDialog
      request={next}
      onDone={(outcome) => {
        if (next) setDismissed((d) => new Set(d).add(next.id));
        if (outcome !== "dismissed") void check();
      }}
    />
  );
}
