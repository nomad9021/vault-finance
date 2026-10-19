import { ApiRequestError, type AiHostStatus } from "@vault/shared";
import { Button, Spinner } from "@vault/ui";
import { useEffect, useRef, useState } from "react";
import { useApp } from "../../state/store.js";

/** Poll fast while the AI server boots, slowly otherwise. */
const POLL_STARTING_MS = 3_000;
const POLL_IDLE_MS = 20_000;

const DOT: Record<AiHostStatus["power"], string> = {
  on: "var(--color-positive)",
  starting: "var(--color-warning)",
  off: "var(--content-tertiary)",
  unknown: "var(--color-negative)",
};

/**
 * One line above the chat saying whether the separate AI server is on,
 * asleep or starting, with a Start button when Vault can switch it on.
 * Hidden when AI runs in the cloud or is turned off.
 */
export function AiHostBar({
  onChange,
}: {
  /** Called with the latest status, so the page can react when the server comes up. */
  onChange?: (status: AiHostStatus) => void;
}) {
  const client = useApp((s) => s.client);
  const [status, setStatus] = useState<AiHostStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let next: AiHostStatus | null = null;
      try {
        next = await client.aiHost();
      } catch {
        /* keep the last status; the next poll retries */
      }
      if (cancelled) return;
      if (next) {
        setStatus(next);
        onChangeRef.current?.(next);
      }
      timer = setTimeout(tick, next?.power === "starting" ? POLL_STARTING_MS : POLL_IDLE_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `starting` restarts the loop right after Start so it polls fast at once.
  }, [client, starting]);

  if (!status?.applies) return null;

  const start = async () => {
    setError(null);
    setStarting(true);
    try {
      const next = await client.startAiHost();
      setStatus(next);
      onChangeRef.current?.(next);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't reach the Vault server to start the AI server.");
    } finally {
      setStarting(false);
    }
  };

  const queued = status.queue ? status.queue.active + status.queue.waiting : 0;
  const text =
    status.power === "on"
      ? queued > 0
        ? `AI server on · ${status.queue!.active} running, ${status.queue!.waiting} waiting`
        : "AI server on"
      : status.power === "starting"
        ? "AI server starting — usually under a minute"
        : status.power === "off"
          ? status.canStart
            ? "AI server is asleep"
            : "AI server is off — switch it on, then come back"
          : (status.message ?? "Can't tell whether the AI server is on");

  return (
    <div
      role="status"
      style={{
        flex: "none",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 24px",
        borderBottom: "1px solid var(--color-divider)",
        fontSize: "var(--text-sm)",
        minHeight: 44,
      }}
    >
      {status.power === "starting" ? (
        <Spinner label="Starting" />
      ) : (
        <span
          aria-hidden
          style={{ width: 8, height: 8, borderRadius: "50%", background: DOT[status.power], flex: "none" }}
        />
      )}
      <span style={{ flex: 1, minWidth: 0 }} className={status.power === "unknown" ? "neg" : undefined}>
        {error ?? text}
      </span>
      {status.canStart && (status.power === "off" || status.power === "unknown") && (
        <Button variant="primary" onClick={() => void start()} disabled={starting}>
          {starting ? <Spinner label="Starting" /> : "Start"}
        </Button>
      )}
    </div>
  );
}
