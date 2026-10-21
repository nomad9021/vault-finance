import { PassThrough } from "node:stream";
import {
  AiActionClientResult,
  AiTestRequest,
  ChatRequest,
  CLIENT_ACTION_TYPES,
  CLOUD_PROVIDERS,
  extractAssistantBlocks,
  extractQueryBlocks,
  stripAssistantBlocks,
  UpdateAiSettingsRequest,
  type AiTestResponse,
  type ChatStreamLine,
  type AiActionRecord,
  type Category,
  type ConversationDetail,
} from "@vault/shared";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { aiActions, aiConversations, aiMessages, aiSettings } from "../../db/schema.js";
import { appendMemory, MEMORY_PROMPT_LIMIT, readMemory } from "../../lib/ai-memory.js";
import { applyStoredAction, buildActionGuide, call, checkActions, recordActions, toRecord } from "./actions.js";
import { AppError, notFound } from "../../errors.js";
import type { AppConfig } from "../../config.js";
import { buildFinancialContext } from "./context.js";
import { createAiHost, ProxmoxError } from "./host.js";
import { configForFeature } from "./model-manager.js";
import { answerQueries, describeQueries } from "./queries.js";
import { describeAiError, getProvider, isConfigured, type ChatMessage } from "./providers/index.js";
import { resolveSettings, statusFor } from "./settings.js";
import { decryptSecret, encryptSecret } from "../../secret-crypto.js";

const HISTORY_LIMIT = 20;
/** Model calls per chat message: the answer plus up to 3 rounds of look-ups. */
const AGENT_MAX_STEPS = 4;

export default async function aiRoutes(
  app: FastifyInstance,
  opts: { config: AppConfig },
) {
  app.addHook("preHandler", app.requireAuth);

  app.get("/ai/status", async () => {
    return statusFor(await resolveSettings(app, opts.config));
  });

  // Separate AI server: on / asleep / starting, shown at the top of the
  // assistant. Any signed-in member may start it (it only switches a VM on);
  // stopping is left to the AI server's own idle timer.
  const aiHost = createAiHost(opts.config);
  app.get("/ai/host", async () => aiHost.status(await resolveSettings(app, opts.config)));
  app.post("/ai/host/start", async (request) => {
    try {
      await aiHost.start();
    } catch (err) {
      if (!(err instanceof ProxmoxError)) throw err;
      request.log.warn({ err }, "couldn't start the AI server");
      throw new AppError("AI_HOST_START_FAILED", 502, err.message);
    }
    request.log.info({ userId: request.auth!.userId }, "AI server start requested");
    return aiHost.status(await resolveSettings(app, opts.config));
  });

  app.post(
    "/ai/settings",
    { preHandler: [app.requireOwner] },
    async (request) => {
      const body = UpdateAiSettingsRequest.parse(request.body);
      const current = await app.db.query.aiSettings.findFirst();

      // apiKey semantics: omitted keeps the stored key, empty string clears it.
      // The stored value is already ciphertext, so the "keep it" branch must
      // pass it through untouched — only freshly supplied plaintext is encrypted.
      const apiKey =
        body.apiKey === undefined
          ? (current?.apiKey ?? null)
          : body.apiKey.trim() === ""
            ? null
            : encryptSecret(body.apiKey.trim());

      const values = {
        id: true as const,
        provider: body.provider,
        model: body.model.trim(),
        apiKey,
        baseUrl: body.baseUrl?.trim() ?? "",
        enabled: body.enabled,
        // Omitted → keep the stored map/flag.
        qualityModels:
          body.qualityModels !== undefined
            ? JSON.stringify(body.qualityModels)
            : (current?.qualityModels ?? "{}"),
        showModelNames:
          body.showModelNames !== undefined
            ? body.showModelNames
            : (current?.showModelNames ?? false),
      };
      await app.db
        .insert(aiSettings)
        .values(values)
        .onConflictDoUpdate({ target: aiSettings.id, set: values });

      return statusFor(await resolveSettings(app, opts.config));
    },
  );

  // Try a provider configuration before saving it — "Test connection" for a
  // separate AI machine. Owner-only: it makes the server fetch an address the
  // caller chose, which is exactly the owner's job and nobody else's.
  app.post(
    "/ai/test",
    { preHandler: [app.requireOwner] },
    async (request): Promise<AiTestResponse> => {
      const body = AiTestRequest.parse(request.body);
      const stored = await app.db.query.aiSettings.findFirst();
      const apiKey =
        body.apiKey !== undefined
          ? body.apiKey.trim() || null
          : stored?.provider === body.provider
            ? decryptSecret(stored.apiKey ?? null)
            : null;
      const candidate = {
        provider: body.provider,
        model: "",
        apiKey,
        baseUrl: body.baseUrl?.trim() ?? "",
      };
      if (!isConfigured(candidate)) {
        return {
          ok: false,
          models: [],
          latencyMs: 0,
          error: CLOUD_PROVIDERS.has(body.provider) ? "Enter an API key first." : "Enter the AI server's address first.",
          hint: CLOUD_PROVIDERS.has(body.provider)
            ? "The key is stored on your Vault server, never on this device."
            : "For example http://192.168.1.50:11434 for Ollama on another computer.",
        };
      }
      const started = Date.now();
      try {
        const models = await getProvider(body.provider).listModels(candidate);
        return { ok: true, models, latencyMs: Date.now() - started };
      } catch (err) {
        request.log.info({ err, provider: body.provider }, "AI connection test failed");
        return { ok: false, models: [], latencyMs: Date.now() - started, ...describeAiError(err, candidate) };
      }
    },
  );

  // Refresh the provider's installed-model list without a restart — powers the
  // quality-mapping dropdowns in Settings.
  app.get("/ai/models", async () => {
    const settings = await resolveSettings(app, opts.config);
    if (!isConfigured(settings.aiConfig)) return { models: [] };
    try {
      return { models: await getProvider(settings.provider).listModels(settings.aiConfig) };
    } catch {
      return { models: [] };
    }
  });

  app.get("/ai/conversations", async (request) => {
    const rows = await app.db.query.aiConversations.findMany({
      where: eq(aiConversations.userId, request.auth!.userId),
      orderBy: (t, { desc: d }) => [d(t.updatedAt)],
    });
    return {
      conversations: rows.map((c) => ({
        id: c.id,
        title: c.title,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      })),
    };
  });

  app.get<{ Params: { id: string } }>("/ai/conversations/:id", async (request) => {
    const conversation = await app.db.query.aiConversations.findFirst({
      where: and(
        eq(aiConversations.id, request.params.id),
        eq(aiConversations.userId, request.auth!.userId),
      ),
    });
    if (!conversation) throw notFound("Conversation");
    const messages = await app.db.query.aiMessages.findMany({
      where: eq(aiMessages.conversationId, conversation.id),
      orderBy: (t, { asc }) => [asc(t.createdAt)],
    });
    const actionsByMessage = await actionsForConversation(conversation.id);
    const detail: ConversationDetail = {
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
        actions: actionsByMessage.get(m.id) ?? [],
      })),
    };
    return detail;
  });

  app.delete<{ Params: { id: string } }>(
    "/ai/conversations/:id",
    async (request, reply) => {
      const [deleted] = await app.db
        .delete(aiConversations)
        .where(
          and(
            eq(aiConversations.id, request.params.id),
            eq(aiConversations.userId, request.auth!.userId),
          ),
        )
        .returning({ id: aiConversations.id });
      if (!deleted) throw notFound("Conversation");
      return reply.status(204).send();
    },
  );

  async function actionsForConversation(conversationId: string): Promise<Map<string, AiActionRecord[]>> {
    const rows = await app.db
      .select()
      .from(aiActions)
      .where(eq(aiActions.conversationId, conversationId))
      .orderBy(asc(aiActions.createdAt));
    const out = new Map<string, AiActionRecord[]>();
    for (const r of rows) {
      if (!r.messageId) continue;
      const list = out.get(r.messageId) ?? [];
      list.push(toRecord(r));
      out.set(r.messageId, list);
    }
    return out;
  }

  /** A pending action belonging to the caller, or 404 / 409. */
  async function pendingAction(id: string, userId: string) {
    const row = await app.db.query.aiActions.findFirst({
      where: and(eq(aiActions.id, id), eq(aiActions.userId, userId)),
    });
    if (!row) throw notFound("Change");
    if (row.status !== "pending") {
      throw new AppError("VALIDATION_ERROR", 409, `This change was already ${row.status}.`);
    }
    return row;
  }

  // Approve a proposed change: the server carries it out as the approving
  // user (owner-only changes still need the owner).
  app.post<{ Params: { id: string } }>("/ai/actions/:id/approve", async (request) => {
    const row = await pendingAction(request.params.id, request.auth!.userId);
    if (CLIENT_ACTION_TYPES.has(toRecord(row).action.type)) {
      throw new AppError("VALIDATION_ERROR", 400, "The app applies this change itself — report its result instead.");
    }
    const updated = await applyStoredAction(app, request, row);
    request.log.info({ actionId: row.id, status: updated.status }, "AI change approved");
    return toRecord(updated);
  });

  app.post<{ Params: { id: string } }>("/ai/actions/:id/reject", async (request) => {
    const row = await pendingAction(request.params.id, request.auth!.userId);
    const [updated] = await app.db
      .update(aiActions)
      .set({ status: "rejected", decidedAt: new Date() })
      .where(eq(aiActions.id, row.id))
      .returning();
    return toRecord(updated!);
  });

  // Outcome of a change the app applied on this device (theme, review prefs).
  app.post<{ Params: { id: string } }>("/ai/actions/:id/result", async (request) => {
    const body = AiActionClientResult.parse(request.body);
    const row = await pendingAction(request.params.id, request.auth!.userId);
    if (!CLIENT_ACTION_TYPES.has(toRecord(row).action.type)) {
      throw new AppError("VALIDATION_ERROR", 400, "Only changes the app applies itself report a result.");
    }
    const [updated] = await app.db
      .update(aiActions)
      .set({ status: body.status, error: body.error ?? null, decidedAt: new Date() })
      .where(eq(aiActions.id, row.id))
      .returning();
    return toRecord(updated!);
  });

  // The assistant's long-term memory (append-only file; see lib/ai-memory.ts).
  app.get("/ai/memory", async (request) => ({
    notes: readMemory(opts.config.dataDir, request.auth!.userId),
  }));

  /**
   * Streaming chat (ADR-0005): NDJSON over chunked HTTP. Failures before the
   * first byte are ordinary JSON errors (clean client handling); failures
   * mid-stream become a terminal {error} line.
   */
  app.post("/ai/chat", async (request, reply) => {
    const body = ChatRequest.parse(request.body);
    const userId = request.auth!.userId;

    const settings = await resolveSettings(app, opts.config);
    if (!settings.enabled) {
      throw new AppError("AI_DISABLED", 503, "The AI assistant is turned off in Settings.");
    }
    if (!isConfigured(settings.aiConfig)) {
      throw new AppError(
        "AI_UNAVAILABLE",
        503,
        "The AI assistant isn't fully configured yet. Add your provider details in Settings.",
      );
    }
    const aiConfig = configForFeature(settings, "chat", body.level);
    const provider = getProvider(aiConfig.provider);
    const isCloud = CLOUD_PROVIDERS.has(aiConfig.provider);

    // Probe before touching the conversation so an unreachable provider or a
    // rejected key returns a clean JSON 503, not a half-created conversation.
    try {
      await provider.listModels(aiConfig);
    } catch {
      throw new AppError(
        "AI_UNAVAILABLE",
        503,
        isCloud
          ? `Couldn't reach ${aiConfig.provider} — check your API key and model in Settings. Every other feature keeps working.`
          : aiHost.canStart
            ? "The AI server is asleep or still starting. Press Start above the chat, then try again in a minute."
            : `Can't reach the AI server at ${aiConfig.baseUrl}. Every other feature keeps working — check Settings → AI.`,
      );
    }

    // Load-or-create the conversation and persist the user's message.
    let conversationId: string;
    if (body.conversationId) {
      const existing = await app.db.query.aiConversations.findFirst({
        where: and(
          eq(aiConversations.id, body.conversationId),
          eq(aiConversations.userId, userId),
        ),
      });
      if (!existing) throw notFound("Conversation");
      conversationId = existing.id;
    } else {
      const [created] = await app.db
        .insert(aiConversations)
        .values({ userId, title: body.message.slice(0, 60) })
        .returning({ id: aiConversations.id });
      conversationId = created!.id;
    }
    await app.db
      .insert(aiMessages)
      .values({ conversationId, role: "user", content: body.message });

    // Assemble the model's view: system context + recent history.
    const memory = readMemory(opts.config.dataDir, userId).slice(-MEMORY_PROMPT_LIMIT);
    const context = [
      await buildFinancialContext(app.db),
      await buildActionGuide(app, request),
      "",
      "REMEMBERED about this user (from earlier chats):",
      ...(memory.length ? memory.map((n) => `  - ${n.text}`) : ["  (nothing yet)"]),
    ].join("\n");
    const history = await app.db.query.aiMessages.findMany({
      where: eq(aiMessages.conversationId, conversationId),
      orderBy: (t, { desc: d }) => [d(t.createdAt)],
      limit: HISTORY_LIMIT,
    });
    // Remind the model what it proposed earlier and what became of it.
    const pastActions = await actionsForConversation(conversationId);
    const messages: ChatMessage[] = [
      { role: "system", content: context },
      ...history.reverse().map((m) => {
        const acts = pastActions.get(m.id) ?? [];
        const note = acts.length
          ? `\n[Changes proposed: ${acts.map((a) => `${a.summary} — ${a.status}${a.error ? ` (${a.error})` : ""}`).join("; ")}]`
          : "";
        return { role: m.role, content: m.content + note };
      }),
    ];

    const stream = new PassThrough();
    const writeLine = (line: ChatStreamLine) => {
      stream.write(JSON.stringify(line) + "\n");
    };

    reply
      .header("content-type", "application/x-ndjson")
      .header("cache-control", "no-store")
      .send(stream);

    // Pump in the background — the reply stream is already on its way.
    void (async () => {
      let assistantText = "";
      try {
        // Agent loop: a reply may ask for look-ups (<vault-query>); the
        // server answers them and the model continues, up to MAX_STEPS
        // rounds. Plain text both ways, so it works with every model.
        let thinking = false;
        let convo = messages;
        const seenQueries = new Set<string>();
        let lastStep = "";
        for (let step = 1; ; step++) {
          let stepText = "";
          await provider.streamChat(
            aiConfig,
            convo,
            (token) => {
              stepText += token;
              assistantText += token;
              writeLine({ token });
            },
            undefined,
            () => {
              if (thinking || assistantText) return;
              thinking = true;
              writeLine({ thinking: true });
            },
          );
          lastStep = stepText;
          const { queries, invalid } = extractQueryBlocks(stepText);
          if ((!queries.length && !invalid.length) || step >= AGENT_MAX_STEPS) break;
          writeLine({ status: describeQueries(queries) });
          const results = await answerQueries(app, queries, invalid, AGENT_MAX_STEPS - step - 1, seenQueries);
          convo = [...convo, { role: "assistant", content: stepText }, { role: "user", content: results }];
          // Keep the visible parts of each step apart.
          if (stripAssistantBlocks(stepText)) {
            assistantText += "\n\n";
            writeLine({ token: "\n\n" });
          }
          thinking = false;
        }
        let blocks = extractAssistantBlocks(assistantText);

        // Rule check: changes that would fail (or don't parse) go back to the
        // model once to fix; whatever still fails is dropped, so the user
        // only ever sees changes that can be applied.
        const treeNow = (await call<{ categories: Category[] }>(app, request, "GET", "/categories")).categories;
        const problems = checkActions(treeNow, blocks.actions);
        if (problems.some(Boolean) || blocks.invalid.length) {
          writeLine({ status: "Double-checking the changes…" });
          const report = [
            "=== RULE CHECK ===",
            "Some of your proposed changes can't be applied as written:",
            ...blocks.actions.flatMap((act, i) => (problems[i] ? [`- ${JSON.stringify(act)} → ${problems[i]}`] : [])),
            ...blocks.invalid.slice(0, 5).map((raw) => `- ${raw.slice(0, 200)} → not valid JSON or not a known change type/fields`),
            "Reply with corrected <vault-action> blocks for ONLY these (leave one out if it can't be done) and one short sentence on what you fixed. The other changes are fine; don't repeat them.",
          ].join("\n");
          let fixText = "";
          await provider.streamChat(
            aiConfig,
            [...convo, { role: "assistant", content: lastStep }, { role: "user", content: report }],
            (token) => {
              if (!fixText && token.trim()) {
                assistantText += "\n\n";
                writeLine({ token: "\n\n" });
              }
              fixText += token;
              assistantText += token;
              writeLine({ token });
            },
          );
          const kept = blocks.actions.filter((_, i) => !problems[i]);
          const fixes = extractAssistantBlocks(fixText).actions;
          const fixProblems = checkActions(treeNow, [...kept, ...fixes]).slice(kept.length);
          const accepted = fixes.filter((_, i) => !fixProblems[i]);
          const dropped = blocks.actions.length - kept.length + blocks.invalid.length - accepted.length;
          if (dropped > 0) request.log.info({ dropped }, "AI changes dropped by the rule check");
          blocks = { ...extractAssistantBlocks(assistantText), actions: [...kept, ...accepted], invalid: [] };
        }
        const [saved] = await app.db
          .insert(aiMessages)
          .values({ conversationId, role: "assistant", content: blocks.visible || assistantText })
          .returning({ id: aiMessages.id });
        await app.db
          .update(aiConversations)
          .set({ updatedAt: new Date() })
          .where(eq(aiConversations.id, conversationId));

        let rows = await recordActions(app, { conversationId, messageId: saved!.id, userId }, blocks.actions);
        if (body.autoApply) {
          const applied = [];
          for (const row of rows) {
            const isClient = CLIENT_ACTION_TYPES.has(toRecord(row).action.type);
            applied.push(isClient ? row : await applyStoredAction(app, request, row));
          }
          rows = applied;
          if (rows.length) request.log.info({ count: rows.length }, "AI changes auto-applied");
        }
        if (rows.length) writeLine({ actions: rows.map(toRecord) });

        if (blocks.remember.length) {
          try {
            appendMemory(opts.config.dataDir, userId, blocks.remember);
            writeLine({ remembered: blocks.remember });
          } catch (err) {
            request.log.error({ err }, "couldn't write AI memory");
          }
        }
        writeLine({ done: true, conversationId });
      } catch (err) {
        request.log.warn({ err }, "ai chat stream failed");
        writeLine({
          error: {
            code: "AI_UNAVAILABLE",
            message: "The model stopped responding. Try again.",
          },
        });
      } finally {
        stream.end();
      }
    })();

    return reply;
  });
}
