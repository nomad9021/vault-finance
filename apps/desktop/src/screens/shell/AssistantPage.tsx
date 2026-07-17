import {
  AI_PROVIDER_LABELS,
  ApiRequestError,
  type AiStatus,
} from "@vault/shared";
import { Banner, Button, Spinner, Tag } from "@vault/ui";
import { useEffect, useRef, useState } from "react";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";
import type { PageId } from "./AppShell.js";

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  pending?: boolean;
}

/** The design's "Try asking" chip rail — each maps to the AI feature list. */
const CHIPS = [
  "Explain my spending habits this month",
  "How am I doing against my budgets?",
  "Summarize my cash flow",
  "Where could I save money?",
  "What were my biggest expenses recently?",
  "Compare my spending to last month",
  "How is my net worth looking?",
];

export function AssistantPage({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  const client = useApp((s) => s.client);
  const { data: status, reload: reloadStatus } = useData<AiStatus>(
    () => client.aiStatus(),
    [client],
  );

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conversationRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    setInput("");
    setMessages((prev) => [
      ...prev,
      { role: "user", text: message },
      { role: "assistant", text: "", pending: true },
    ]);

    const appendToken = (token: string) => {
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1]!;
        next[next.length - 1] = { role: "assistant", text: last.text + token };
        return next;
      });
    };

    try {
      const { conversationId } = await client.chat(
        {
          message,
          ...(conversationRef.current ? { conversationId: conversationRef.current } : {}),
        },
        appendToken,
      );
      conversationRef.current = conversationId;
    } catch (err) {
      setMessages((prev) => prev.filter((m) => !(m.pending && m.text === "")));
      if (err instanceof ApiRequestError && err.code === "AI_UNAVAILABLE") {
        setError(err.message);
        void reloadStatus();
      } else if (err instanceof ApiRequestError) {
        setError(err.message);
      } else {
        setError("The response was interrupted. Your question wasn't lost — try again.");
      }
    } finally {
      setBusy(false);
      setMessages((prev) =>
        prev.map((m) => (m.pending ? { role: m.role, text: m.text } : m)),
      );
    }
  };

  const aiOffline =
    status !== null && (!status.enabled || !status.configured || !status.reachable);
  const providerLabel = status ? AI_PROVIDER_LABELS[status.provider] : "The provider";

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0, animation: "fadeUp .3s both", margin: -24 }}>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {aiOffline && (
          <Banner
            tone="warning"
            action={
              <Button variant="ghost" onClick={() => onNavigate("settings")}>
                Open AI settings
              </Button>
            }
          >
            {!status.enabled
              ? "The AI assistant is turned off in Settings."
              : !status.configured
                ? "The AI assistant isn't fully configured — finish setup in Settings."
                : `${providerLabel} isn't reachable right now. Everything else keeps working.`}
          </Banner>
        )}

        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflow: "auto",
            padding: 24,
            display: "flex",
            flexDirection: "column",
            gap: 16,
            minHeight: 0,
          }}
        >
          {messages.length === 0 && (
            <div className="text-muted" style={{ fontSize: 13.5, maxWidth: 480, lineHeight: 1.7 }}>
              Ask anything about your money — spending, budgets, cash flow,
              forecasts. Answers come from a model running on your own server;
              nothing leaves your hardware.
            </div>
          )}
          {messages.map((m, i) =>
            m.role === "user" ? (
              <div
                key={i}
                style={{
                  alignSelf: "flex-end",
                  maxWidth: "72%",
                  background: "var(--color-accent-800)",
                  color: "var(--color-accent-100)",
                  padding: "9px 14px",
                  borderRadius: "16px 16px 4px 16px",
                  fontSize: 13.5,
                  lineHeight: 1.5,
                }}
              >
                {m.text}
              </div>
            ) : (
              <div
                key={i}
                style={{
                  alignSelf: "flex-start",
                  maxWidth: "82%",
                  display: "flex",
                  flexDirection: "column",
                  gap: 7,
                }}
              >
                <Tag variant="accent" style={{ alignSelf: "flex-start", fontSize: 10 }}>
                  ✦ AI advisor
                </Tag>
                {m.pending && m.text === "" ? (
                  <div
                    style={{
                      fontSize: 20,
                      letterSpacing: 3,
                      color: "var(--color-neutral-500)",
                      animation: "blink 1s infinite",
                    }}
                  >
                    ···
                  </div>
                ) : (
                  <div style={{ fontSize: 13.5, lineHeight: 1.6, whiteSpace: "pre-line" }}>
                    {m.text}
                  </div>
                )}
              </div>
            ),
          )}
          {error && (
            <div role="alert" style={{ fontSize: 13, color: "var(--color-negative)" }}>
              {error}
            </div>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
          style={{
            flex: "none",
            borderTop: "1px solid var(--color-divider)",
            padding: "12px 24px",
            display: "flex",
            gap: 10,
          }}
        >
          <input
            className="input"
            style={{ flex: 1, borderRadius: 10 }}
            placeholder="Ask about your money…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={aiOffline}
            aria-label="Ask about your money"
          />
          <Button
            variant="primary"
            type="submit"
            style={{ whiteSpace: "nowrap" }}
            disabled={busy || aiOffline || !input.trim()}
          >
            {busy ? <Spinner label="Thinking" /> : "Send"}
          </Button>
        </form>
      </div>

      <div
        style={{
          width: 280,
          flex: "none",
          borderLeft: "1px solid var(--color-divider)",
          padding: 18,
          overflow: "auto",
        }}
      >
        <div
          style={{
            fontSize: 11,
            letterSpacing: ".05em",
            textTransform: "uppercase",
            color: "var(--color-neutral-500)",
            fontWeight: 600,
            marginBottom: 12,
          }}
        >
          Try asking
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {CHIPS.map((chip) => (
            <Button
              key={chip}
              variant="secondary"
              style={{
                justifyContent: "flex-start",
                textAlign: "left",
                fontWeight: 500,
                fontSize: 12.5,
                borderRadius: 9,
              }}
              disabled={busy || aiOffline}
              onClick={() => void send(chip)}
            >
              {chip}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
