import {
  AI_LEVEL_HINTS,
  AI_LEVEL_LABELS,
  AI_LEVELS,
  AI_PROVIDER_LABELS,
  ApiRequestError,
  stripAssistantBlocks,
  type AiActionRecord,
  type AiHostStatus,
  type AiStatus,
  type ConversationListResponse,
} from "@vault/shared";
import { Banner, Button, Dialog, Segmented, Spinner, Tag } from "@vault/ui";
import { useEffect, useRef, useState } from "react";
import { applyClientAction } from "../../lib/aiClientActions.js";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";
import { AiHostBar } from "./AiHostBar.js";
import type { PageId } from "./AppShell.js";

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  pending?: boolean;
  /** The model is reasoning before it answers (AI level High). */
  thinking?: boolean;
  /** Changes this reply proposed. */
  actions?: AiActionRecord[];
  /** Notes it saved to the assistant's memory. */
  remembered?: string[];
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
  "Suggest a cleaner category tree for me",
  "Set up budgets based on last month",
];

export function AssistantPage({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  const client = useApp((s) => s.client);
  const { data: status, reload: reloadStatus } = useData<AiStatus>(
    () => client.aiStatus(),
    [client],
  );

  // The AI server's power state. When it comes on, re-check AI status so the
  // input unlocks without leaving the page.
  const [hostPower, setHostPower] = useState<AiHostStatus["power"] | null>(null);
  const onHostChange = (host: AiHostStatus) => {
    const power = host.applies ? host.power : null;
    if (power === "on" && hostPower !== null && hostPower !== "on") void reloadStatus();
    setHostPower(power);
  };

  const autoApply = useApp((s) => s.aiAutoApply);
  const setAutoApply = useApp((s) => s.setAiAutoApply);
  const level = useApp((s) => s.aiLevel);
  const setLevel = useApp((s) => s.setAiLevel);
  const { data: convoList, reload: reloadConvos } = useData<ConversationListResponse>(
    () => client.conversations(),
    [client],
  );

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null);
  const conversationRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const startNewChat = () => {
    if (busy) return;
    conversationRef.current = null;
    setActiveId(null);
    setMessages([]);
    setError(null);
  };

  const openConversation = async (id: string) => {
    if (busy) return;
    setError(null);
    try {
      const detail = await client.conversation(id);
      conversationRef.current = id;
      setActiveId(id);
      setMessages(
        detail.messages.map((m) => ({
          role: m.role,
          text: m.role === "assistant" ? stripAssistantBlocks(m.content) : m.content,
          actions: m.actions ?? [],
        })),
      );
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't open that chat.");
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await client.deleteConversation(deleting.id);
      if (conversationRef.current === deleting.id) startNewChat();
      void reloadConvos();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't delete that chat.");
    } finally {
      setDeleting(null);
    }
  };

  /** Swap in an updated action record wherever it appears. */
  const updateAction = (next: AiActionRecord) =>
    setMessages((prev) =>
      prev.map((m) =>
        m.actions?.some((a) => a.id === next.id)
          ? { ...m, actions: m.actions.map((a) => (a.id === next.id ? next : a)) }
          : m,
      ),
    );

  const decide = async (record: AiActionRecord, approve: boolean) => {
    try {
      const next = !approve
        ? await client.rejectAiAction(record.id)
        : record.client
          ? await applyClientAction(record)
          : await client.approveAiAction(record.id);
      updateAction(next);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't apply that change.");
    }
  };

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

    const patchLast = (patch: (m: ChatMessage) => ChatMessage) =>
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = patch(next[next.length - 1]!);
        return next;
      });
    const appendToken = (token: string) => patchLast((m) => ({ ...m, text: m.text + token }));

    const clientPending: AiActionRecord[] = [];
    try {
      const { conversationId } = await client.chat(
        {
          message,
          autoApply,
          level,
          ...(conversationRef.current ? { conversationId: conversationRef.current } : {}),
        },
        appendToken,
        {
          onActions: (actions) => {
            patchLast((m) => ({ ...m, actions }));
            clientPending.push(...actions.filter((a) => a.client && a.status === "pending"));
          },
          onRemembered: (remembered) => patchLast((m) => ({ ...m, remembered })),
          onThinking: () => patchLast((m) => (m.thinking ? m : { ...m, thinking: true })),
        },
      );
      conversationRef.current = conversationId;
      setActiveId(conversationId);
      void reloadConvos();
      // Auto mode: the app's own changes (theme, review settings) apply here.
      if (autoApply) for (const a of clientPending) updateAction(await applyClientAction(a));
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
      setMessages((prev) => prev.map((m) => (m.pending ? { ...m, pending: false } : m)));
    }
  };

  const aiOffline =
    status !== null && (!status.enabled || !status.configured || !status.reachable);
  const providerLabel = status ? AI_PROVIDER_LABELS[status.provider] : "The provider";

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0, animation: "fadeUp .3s both", margin: -24 }}>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <AiHostBar onChange={onHostChange} />
        {/* The bar above already says the AI server is asleep or starting. */}
        {aiOffline && !(status.enabled && status.configured && hostPower && hostPower !== "on") && (
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
            <div className="text-muted" style={{ fontSize: "var(--text-base)", maxWidth: 480, lineHeight: 1.7 }}>
              Ask anything about your money — spending, budgets, cash flow,
              forecasts. It can also reorganise your categories, add rules and
              budgets, and change review and theme settings — it asks first
              unless you switch on Auto. Your chats are kept until you delete
              them, and what it learns about you is remembered for next time.
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
                  fontSize: "var(--text-base)",
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
                <Tag variant="accent" style={{ alignSelf: "flex-start", fontSize: "var(--text-3xs)" }}>
                  ✦ AI advisor
                </Tag>
                {m.pending && m.text === "" ? (
                  m.thinking ? (
                    <div
                      style={{ fontSize: "var(--text-sm)", color: "var(--content-tertiary)", animation: "blink 1.6s infinite" }}
                    >
                      Thinking it through…
                    </div>
                  ) : (
                    <div
                      style={{
                        fontSize: "var(--text-xl)",
                        letterSpacing: 3,
                        color: "var(--content-tertiary)",
                        animation: "blink 1s infinite",
                      }}
                    >
                      ···
                    </div>
                  )
                ) : (
                  <div style={{ fontSize: "var(--text-base)", lineHeight: 1.6, whiteSpace: "pre-line" }}>
                    {stripAssistantBlocks(m.text)}
                  </div>
                )}
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
            style={{ flex: 1, borderRadius: "var(--radius-md)" }}
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
        <SideHeading>AI level</SideHeading>
        <Segmented
          aria-label="AI level"
          options={AI_LEVELS.map((l) => ({ value: l, label: AI_LEVEL_LABELS[l] }))}
          value={level}
          onChange={(v) => void setLevel(v)}
        />
        <p className="card-meta" style={{ margin: "6px 0 18px" }}>
          {AI_LEVEL_HINTS[level]}
        </p>

        <SideHeading>Changes</SideHeading>
        <Segmented
          aria-label="When the assistant wants to change something"
          options={[
            { value: "ask", label: "Ask me first" },
            { value: "auto", label: "Auto" },
          ]}
          value={autoApply ? "auto" : "ask"}
          onChange={(v) => void setAutoApply(v === "auto")}
        />
        <p className="card-meta" style={{ margin: "6px 0 18px" }}>
          {autoApply
            ? "Changes it suggests are made straight away. Each still shows in the chat."
            : "You approve each change before it's made."}
        </p>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <SideHeading>Chats</SideHeading>
          <Button variant="ghost" size="sm" icon="plus" onClick={startNewChat} disabled={busy}>
            New
          </Button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 18, maxHeight: 260, overflow: "auto" }}>
          {(convoList?.conversations ?? []).length === 0 && (
            <div className="card-meta">Saved chats appear here.</div>
          )}
          {(convoList?.conversations ?? []).map((c) => (
            <div
              key={c.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                borderRadius: "var(--radius-md)",
                background: c.id === activeId ? "color-mix(in srgb, var(--color-accent) 12%, transparent)" : "none",
              }}
            >
              <button
                onClick={() => void openConversation(c.id)}
                disabled={busy}
                title={c.title ?? "Untitled chat"}
                style={{
                  flex: 1,
                  minWidth: 0,
                  textAlign: "left",
                  border: 0,
                  background: "none",
                  color: "inherit",
                  font: "inherit",
                  fontSize: "var(--text-sm)",
                  padding: "6px 8px",
                  cursor: "pointer",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {c.title ?? "Untitled chat"}
              </button>
              <Button
                variant="ghost"
                size="sm"
                icon="trash"
                aria-label={`Delete chat ${c.title ?? ""}`}
                onClick={() => setDeleting({ id: c.id, title: c.title ?? "Untitled chat" })}
              />
            </div>
          ))}
        </div>

        <SideHeading>Try asking</SideHeading>
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {CHIPS.map((chip) => (
            <Button
              key={chip}
              variant="secondary"
              style={{
                justifyContent: "flex-start",
                textAlign: "left",
                fontWeight: 500,
                fontSize: "var(--text-sm)",
                borderRadius: "var(--radius-md)",
              }}
              disabled={busy || aiOffline}
              onClick={() => void send(chip)}
            >
              {chip}
            </Button>
          ))}
        </div>
      </div>

      <Dialog
        open={deleting !== null}
        title="Delete this chat?"
        onClose={() => setDeleting(null)}
        actions={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void confirmDelete()}>
              Delete chat
            </Button>
          </>
        }
      >
        "{deleting?.title}" will be removed for good. What the assistant has
        remembered about you is kept — memory is never deleted.
      </Dialog>
    </div>
  );
}

function SideHeading({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: "var(--text-2xs)",
        letterSpacing: ".05em",
        textTransform: "uppercase",
        color: "var(--content-tertiary)",
        fontWeight: 600,
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

const STATUS_LABEL: Record<AiActionRecord["status"], string> = {
  pending: "Waiting for you",
  applied: "Done",
  rejected: "Declined",
  failed: "Didn't work",
};

/** One proposed change: what it is, and Approve / Decline while it's pending. */
function ActionCard({ action, onDecide }: { action: AiActionRecord; onDecide: (approve: boolean) => void }) {
  const [working, setWorking] = useState(false);
  const tone =
    action.status === "applied"
      ? "var(--color-positive)"
      : action.status === "failed"
        ? "var(--color-negative)"
        : "var(--content-tertiary)";
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
