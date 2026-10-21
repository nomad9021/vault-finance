import { ApiRequestError, stripAssistantBlocks, type AiActionRecord } from "@vault/shared";
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
          messages: detail.messages.map((m) => ({
            role: m.role,
            text: m.role === "assistant" ? stripAssistantBlocks(m.content) : m.content,
            actions: m.actions ?? [],
          })),
        });
      } catch (err) {
        set({ error: err instanceof ApiRequestError ? err.message : "Couldn't open that chat." });
      }
    },

    async send(text) {
      const message = text.trim();
      if (!message || get().busy) return;
      const { client, aiAutoApply: autoApply, aiLevel: level } = useApp.getState();
      controller = new AbortController();
      set((s) => ({
        busy: true,
        error: null,
        messages: [...s.messages, { role: "user", text: message }, { role: "assistant", text: "", pending: true }],
      }));
      const clientPending: AiActionRecord[] = [];
      try {
        const conversationId = get().conversationId;
        const result = await client.chat(
          { message, autoApply, level, ...(conversationId ? { conversationId } : {}) },
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
        set((s) => ({ messages: s.messages.filter((m) => !(m.pending && stripAssistantBlocks(m.text) === "")) }));
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
