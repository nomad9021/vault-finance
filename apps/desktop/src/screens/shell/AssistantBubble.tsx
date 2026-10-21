import { AI_LEVEL_LABELS, AI_LEVELS, type AiStatus } from "@vault/shared";
import { Button, Icon, Segmented } from "@vault/ui";
import { useEffect, useState } from "react";
import { useData } from "../../lib/useData.js";
import { useChat } from "../../state/chat.js";
import { useApp } from "../../state/store.js";
import { ChatComposer, ChatMessages } from "./ChatView.js";

/**
 * The assistant on every page: a bubble in the corner (or Ctrl/Cmd+J) opens
 * the same conversation as the Assistant page, so you can ask about what's
 * on screen and keep going on the full page with "Open full page".
 */
export function AssistantBubble({ onOpenPage }: { onOpenPage: () => void }) {
  const [open, setOpen] = useState(false);
  const client = useApp((s) => s.client);
  const level = useApp((s) => s.aiLevel);
  const setLevel = useApp((s) => s.setAiLevel);
  const busy = useChat((s) => s.busy);
  const newChat = useChat((s) => s.newChat);
  const { data: status } = useData<AiStatus | null>(() => (open ? client.aiStatus() : Promise.resolve(null)), [client, open]);
  const offline = !!status && (!status.enabled || !status.configured || !status.reachable);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="Ask the assistant (Ctrl+J)"
        aria-label="Open the assistant"
        style={{
          position: "fixed",
          right: 20,
          bottom: 20,
          zIndex: "var(--z-rail)",
          width: 52,
          height: 52,
          borderRadius: "50%",
          border: 0,
          cursor: "pointer",
          background: "var(--color-accent)",
          color: "var(--color-on-accent, #fff)",
          boxShadow: "var(--shadow-lg)",
          display: "grid",
          placeItems: "center",
          fontSize: 22,
        }}
      >
        {busy ? <span style={{ animation: "blink 1s infinite" }}>✦</span> : "✦"}
      </button>
    );
  }

  return (
    <div
      role="dialog"
      aria-label="Assistant"
      style={{
        position: "fixed",
        right: 20,
        bottom: 20,
        zIndex: "var(--z-rail)",
        width: "min(420px, calc(100vw - 40px))",
        height: "min(600px, calc(100vh - 40px))",
        display: "flex",
        flexDirection: "column",
        background: "var(--color-surface)",
        border: "1px solid var(--color-divider)",
        borderRadius: "var(--radius-xl)",
        boxShadow: "var(--shadow-lg)",
        overflow: "hidden",
        animation: "fadeUp .2s both",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 12px", borderBottom: "1px solid var(--color-divider)" }}>
        <strong style={{ flex: 1, fontSize: "var(--text-sm)" }}>✦ Assistant</strong>
        <Segmented
          aria-label="AI level"
          options={AI_LEVELS.map((l) => ({ value: l, label: AI_LEVEL_LABELS[l] }))}
          value={level}
          onChange={(v) => void setLevel(v)}
        />
        <Button variant="ghost" size="sm" icon="plus" aria-label="New chat" title="New chat" onClick={newChat} disabled={busy} />
        <Button
          variant="ghost"
          size="sm"
          icon="expand"
          aria-label="Open full page"
          title="Open full page"
          onClick={() => {
            setOpen(false);
            onOpenPage();
          }}
        />
        <Button variant="ghost" size="sm" aria-label="Close" title="Close (Esc)" onClick={() => setOpen(false)}>
          <Icon name="close" size={16} />
        </Button>
      </div>
      <ChatMessages
        compact
        empty={
          <div className="card-meta" style={{ lineHeight: 1.6 }}>
            Ask about anything on this page — or tell it what to change. Ctrl+J opens and closes this.
            {offline && <div style={{ color: "var(--color-negative)", marginTop: 8 }}>The AI isn't reachable right now; check Settings → AI.</div>}
          </div>
        }
      />
      <ChatComposer compact autoFocus disabled={offline} />
    </div>
  );
}
