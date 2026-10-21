import { stripAssistantBlocks, type AiActionRecord } from "@vault/shared";
import { Button, Spinner, Tag } from "@vault/ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useChat } from "../../state/chat.js";

/**
 * The chat itself — messages, change cards and the input with Send/Stop —
 * shared by the Assistant page and the floating chat bubble.
 */

const dim = { fontSize: "var(--text-sm)", color: "var(--content-tertiary)", animation: "blink 1.6s infinite" } as const;

export function ChatMessages({ compact = false, empty }: { compact?: boolean; empty?: ReactNode }) {
  const messages = useChat((s) => s.messages);
  const error = useChat((s) => s.error);
  const decide = useChat((s) => s.decide);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  return (
    <div
      ref={scrollRef}
      style={{ flex: 1, overflow: "auto", padding: compact ? 14 : 24, display: "flex", flexDirection: "column", gap: compact ? 12 : 16, minHeight: 0 }}
    >
      {messages.length === 0 && empty}
      {messages.map((m, i) =>
        m.role === "user" ? (
          <div
            key={i}
            style={{
              alignSelf: "flex-end",
              maxWidth: compact ? "85%" : "72%",
              background: "var(--color-accent-800)",
              color: "var(--color-accent-100)",
              padding: "9px 14px",
              borderRadius: "16px 16px 4px 16px",
              fontSize: "var(--text-base)",
              lineHeight: 1.5,
            }}
          >
            {m.text}
          </div>
        ) : (
          <div key={i} style={{ alignSelf: "flex-start", maxWidth: compact ? "95%" : "82%", display: "flex", flexDirection: "column", gap: 7 }}>
            <Tag variant="accent" style={{ alignSelf: "flex-start", fontSize: "var(--text-3xs)" }}>
              ✦ AI advisor
            </Tag>
            {m.pending && stripAssistantBlocks(m.text) === "" ? (
              m.status ? (
                <div style={dim}>{m.status}</div>
              ) : m.thinking ? (
                <div style={dim}>Thinking it through…</div>
              ) : (
                <div style={{ fontSize: "var(--text-xl)", letterSpacing: 3, color: "var(--content-tertiary)", animation: "blink 1s infinite" }}>···</div>
              )
            ) : (
              <div style={{ fontSize: "var(--text-base)", lineHeight: 1.6, whiteSpace: "pre-line" }}>
                {stripAssistantBlocks(m.text)}
                {m.pending && m.status && <div style={{ ...dim, marginTop: 6 }}>{m.status}</div>}
              </div>
            )}
            {m.stopped && <div style={{ fontSize: "var(--text-xs)", color: "var(--content-tertiary)" }}>Stopped.</div>}
            {m.actions?.map((a) => (
              <ActionCard key={a.id} action={a} onDecide={(approve) => void decide(a, approve)} />
            ))}
            {m.remembered?.map((note) => (
              <div key={note} style={{ fontSize: "var(--text-xs)", color: "var(--content-tertiary)" }}>
                ✦ Saved to memory: {note}
              </div>
            ))}
          </div>
        ),
      )}
      {error && (
        <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--color-negative)" }}>
          {error}
        </div>
      )}
    </div>
  );
}

/** Input with Send, which turns into Stop while a reply is coming in. */
export function ChatComposer({ disabled = false, compact = false, autoFocus = false }: { disabled?: boolean; compact?: boolean; autoFocus?: boolean }) {
  const [input, setInput] = useState("");
  const busy = useChat((s) => s.busy);
  const send = useChat((s) => s.send);
  const stop = useChat((s) => s.stop);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        const text = input;
        setInput("");
        void send(text);
      }}
      style={{ flex: "none", borderTop: "1px solid var(--color-divider)", padding: compact ? "10px 12px" : "12px 24px", display: "flex", gap: 10 }}
    >
      <input
        className="input"
        style={{ flex: 1, borderRadius: "var(--radius-md)" }}
        placeholder="Ask about your money…"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        disabled={disabled}
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus={autoFocus}
        aria-label="Ask about your money"
      />
      {busy ? (
        <Button variant="secondary" type="button" onClick={stop} style={{ whiteSpace: "nowrap" }} aria-label="Stop the reply">
          <Spinner label="Thinking" /> Stop
        </Button>
      ) : (
        <Button variant="primary" type="submit" style={{ whiteSpace: "nowrap" }} disabled={disabled || !input.trim()}>
          Send
        </Button>
      )}
    </form>
  );
}

const STATUS_LABEL: Record<AiActionRecord["status"], string> = {
  pending: "Waiting for you",
  applied: "Done",
  rejected: "Declined",
  failed: "Didn't work",
};

/** One proposed change: what it is, and Approve / Decline while it's pending. */
export function ActionCard({ action, onDecide }: { action: AiActionRecord; onDecide: (approve: boolean) => void }) {
  const [working, setWorking] = useState(false);
  const tone = action.status === "applied" ? "var(--color-positive)" : action.status === "failed" ? "var(--color-negative)" : "var(--content-tertiary)";
  const decide = (approve: boolean) => {
    setWorking(true);
    onDecide(approve);
  };
  return (
    <div
      style={{
        border: "1px solid var(--color-divider)",
        borderRadius: "var(--radius-md)",
        background: "var(--color-surface)",
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        fontSize: "var(--text-sm)",
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", justifyContent: "space-between" }}>
        <span style={{ fontWeight: 600 }}>{action.summary}</span>
        <span style={{ color: tone, fontWeight: 600, fontSize: "var(--text-xs)", whiteSpace: "nowrap" }}>
          {action.status === "applied" ? "✓ " : action.status === "failed" ? "✕ " : ""}
          {STATUS_LABEL[action.status]}
        </span>
      </div>
      {action.error && <div style={{ color: "var(--color-negative)", fontSize: "var(--text-xs)" }}>{action.error}</div>}
      {action.status === "pending" && (
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="primary" size="sm" disabled={working} onClick={() => decide(true)}>
            Approve
          </Button>
          <Button variant="ghost" size="sm" disabled={working} onClick={() => decide(false)}>
            Decline
          </Button>
        </div>
      )}
    </div>
  );
}
