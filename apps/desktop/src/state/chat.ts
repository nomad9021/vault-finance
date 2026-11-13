import { ApiRequestError, splitUserMessage, stripAssistantBlocks, type AiActionRecord, type ChatAttachment } from "@vault/shared";
import { create } from "zustand";
import { applyClientAction } from "../lib/aiClientActions.js";
import { useApp } from "./store.js";

/**
 * The assistant conversation, shared by the Assistant page and the floating
 * chat bubble so you can start on one and carry on in the other. Also owns
 * the Stop button: aborting drops the connection and the server stops the
 * model, keeping whatever was written so far.
 */

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  pending?: boolean;
  /** The model is reasoning before it answers (AI level High). */
  thinking?: boolean;
  /** What it's looking up right now (cleared once more text arrives). */
  status?: string;
  /** Changes this reply proposed. */
  actions?: AiActionRecord[];
  /** Notes it saved to the assistant's memory. */
  remembered?: string[];
  /** The user pressed Stop on this reply. */
  stopped?: boolean;
  /** Spreadsheets attached to this (user) message, by name. */
  files?: string[];
}

interface ChatState {
  messages: ChatMessage[];
  conversationId: string | null;
  busy: boolean;
  error: string | null;
  /** Bumped whenever the saved chat list changes, so lists can reload. */
  listVersion: number;
  /** Bumped when a change was applied, so open pages can refresh their data. */
  dataVersion: number;
  /** A spreadsheet waiting to go with the next message. */
  attachment: ChatAttachment | null;
  attach(file: ChatAttachment | null): void;
  /** Approve every pending change of one reply, in order. */
  approveAll(records: AiActionRecord[]): Promise<void>;
  /** Ask every open page to refetch (pull to refresh). */
  refreshData(): void;
  newChat(): void;
  open(id: string): Promise<void>;
  send(text: string): Promise<void>;
  stop(): void;
  decide(record: AiActionRecord, approve: boolean): Promise<void>;
  forget(id: string): void;
  setError(error: string | null): void;
}

let controller: AbortController | null = null;

export const useChat = create<ChatState>((set, get) => {
  const patchLast = (patch: (m: ChatMessage) => ChatMessage) =>
    set((s) => {
      const next = [...s.messages];
      next[next.length - 1] = patch(next[next.length - 1]!);
      return { messages: next };
    });
  const updateAction = (record: AiActionRecord) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.actions?.some((a) => a.id === record.id) ? { ...m, actions: m.actions.map((a) => (a.id === record.id ? record : a)) } : m,
      ),
    }));
  const changed = (records: AiActionRecord[]) => {
    if (records.some((r) => r.status === "applied")) set((s) => ({ dataVersion: s.dataVersion + 1 }));
  };

  return {
    messages: [],
    conversationId: null,
    busy: false,
    error: null,
    listVersion: 0,
    dataVersion: 0,
    attachment: null,

    attach(file) {
      set({ attachment: file });
    },

    async approveAll(records) {
      // In order: a budget can need the category created just before it.
      for (const r of records) if (r.status === "pending") await get().decide(r, true);
    },

    refreshData() {
      set((s) => ({ dataVersion: s.dataVersion + 1 }));
    },

    newChat() {
      if (get().busy) return;
      set({ messages: [], conversationId: null, error: null });
    },

    async open(id) {
      if (get().busy) return;
      set({ error: null });
      try {
        const detail = await useApp.getState().client.conversation(id);
        set({
          conversationId: id,
          messages: detail.messages.map((m) => {
            if (m.role === "assistant") return { role: m.role, text: stripAssistantBlocks(m.content), actions: m.actions ?? [] };
            const { text, files } = splitUserMessage(m.content);
            return { role: m.role, text, actions: [], ...(files.length ? { files } : {}) };
          }),
        });
      } catch (err) {
        set({ error: err instanceof ApiRequestError ? err.message : "Couldn't open that chat." });
      }
    },

    async send(text) {
      const attachment = get().attachment;
      const message = text.trim() || (attachment ? "Import the budget in this spreadsheet." : "");
      if (!message || get().busy) return;
      const { client, aiAutoApply: autoApply, aiLevel: level } = useApp.getState();
      controller = new AbortController();
      set((s) => ({
        busy: true,
        error: null,
        attachment: null,
        messages: [
          ...s.messages,
          { role: "user", text: message, ...(attachment ? { files: [attachment.name] } : {}) },
          { role: "assistant", text: "", pending: true },
        ],
      }));
      const clientPending: AiActionRecord[] = [];
      try {
        const conversationId = get().conversationId;
        const result = await client.chat(
          { message, autoApply, level, ...(conversationId ? { conversationId } : {}), ...(attachment ? { attachment } : {}) },
          (token) =>
            patchLast((m) => {
              const next = { ...m, text: m.text + token };
              if (token.trim()) delete next.status; // new text: the look-up is done
              return next;
            }),
          {
            onActions: (actions) => {
              patchLast((m) => ({ ...m, actions }));
              clientPending.push(...actions.filter((a) => a.client && a.status === "pending"));
              changed(actions);
            },
            onRemembered: (remembered) => patchLast((m) => ({ ...m, remembered })),
            onThinking: () => patchLast((m) => (m.thinking ? m : { ...m, thinking: true })),
            onStatus: (status) => patchLast((m) => ({ ...m, status })),
            signal: controller.signal,
          },
        );
        set((s) => ({ conversationId: result.conversationId, listVersion: s.listVersion + 1 }));
        if (result.stopped) {
          patchLast((m) => ({ ...m, stopped: true, text: stripAssistantBlocks(m.text) }));
          return;
        }
        // Auto mode: the app's own changes (theme, review settings) apply here.
        if (autoApply) for (const a of clientPending) updateAction(await applyClientAction(a));
      } catch (err) {
        if (controller?.signal.aborted) {
          patchLast((m) => ({ ...m, stopped: true }));
          return;
        }
        set((s) => ({
          messages: s.messages.filter((m) => !(m.pending && stripAssistantBlocks(m.text) === "")),
          // Keep the spreadsheet so trying again doesn't mean picking it again.
          ...(attachment && !s.attachment ? { attachment } : {}),
        }));
        set({
          error:
            err instanceof ApiRequestError
              ? err.message
              : "The response was interrupted. Your question wasn't lost — try again.",
        });
      } finally {
        controller = null;
        set((s) => ({ busy: false, messages: s.messages.map((m) => (m.pending ? { ...m, pending: false } : m)) }));
      }
    },

    stop() {
      controller?.abort();
    },

    async decide(record, approve) {
      const { client } = useApp.getState();
      try {
        const next = !approve
          ? await client.rejectAiAction(record.id)
          : record.client
            ? await applyClientAction(record)
            : await client.approveAiAction(record.id);
        updateAction(next);
        changed([next]);
      } catch (err) {
        set({ error: err instanceof ApiRequestError ? err.message : "Couldn't apply that change." });
      }
    },

    forget(id) {
      if (get().conversationId === id) set({ messages: [], conversationId: null });
      set((s) => ({ listVersion: s.listVersion + 1 }));
    },

    setError(error) {
      set({ error });
    },
  };
});
