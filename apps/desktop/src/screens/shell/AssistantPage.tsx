import {
  AI_LEVEL_HINTS,
  AI_LEVEL_LABELS,
  AI_LEVELS,
  AI_PROVIDER_LABELS,
  ApiRequestError,
  type AiHostStatus,
  type AiStatus,
  type ConversationListResponse,
} from "@vault/shared";
import { Banner, Button, Dialog, Segmented } from "@vault/ui";
import { useEffect, useState } from "react";
import { useData } from "../../lib/useData.js";
import { useChat } from "../../state/chat.js";
import { useApp } from "../../state/store.js";
import { AiHostBar } from "./AiHostBar.js";
import type { PageId } from "./AppShell.js";
import { ChatComposer, ChatMessages } from "./ChatView.js";

/** The design's "Try asking" chip rail — each maps to the AI feature list. */
const CHIPS = [
  "Organize my finances and set up my Sankey",
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

  const messages = useChat((s) => s.messages);
  const busy = useChat((s) => s.busy);
  const activeId = useChat((s) => s.conversationId);
  const listVersion = useChat((s) => s.listVersion);
  const startNewChat = useChat((s) => s.newChat);
  const openConversation = useChat((s) => s.open);
  const send = useChat((s) => s.send);
  const forget = useChat((s) => s.forget);
  const setError = useChat((s) => s.setError);
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null);

  // Saved chats reload whenever the shared conversation changes them.
  useEffect(() => {
    if (listVersion) void reloadConvos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listVersion]);

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await client.deleteConversation(deleting.id);
      forget(deleting.id);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't delete that chat.");
    } finally {
      setDeleting(null);
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

        <ChatMessages
          empty={
            <div className="text-muted" style={{ fontSize: "var(--text-base)", maxWidth: 480, lineHeight: 1.7 }}>
              Ask anything about your money — spending, budgets, cash flow, taxes, forecasts. It can also
              reorganise your categories, set budgets, bills and goals, and change settings — it asks first
              unless you switch on Auto. Press Ctrl+J on any page for the chat bubble.
            </div>
          }
        />
        <ChatComposer disabled={aiOffline} />
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
