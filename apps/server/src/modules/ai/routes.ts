import { PassThrough } from "node:stream";
import {
  AI_FEATURE_QUALITY,
  ChatRequest,
  CLOUD_PROVIDERS,
  UpdateAiSettingsRequest,
  type ChatStreamLine,
  type ConversationDetail,
} from "@vault/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { aiConversations, aiMessages, aiSettings } from "../../db/schema.js";
import { AppError, notFound } from "../../errors.js";
import type { AppConfig } from "../../config.js";
import { buildFinancialContext } from "./context.js";
import { configForQuality } from "./model-manager.js";
import { getProvider, isConfigured, type ChatMessage } from "./providers/index.js";
import { resolveSettings, statusFor } from "./settings.js";

const HISTORY_LIMIT = 20;

export default async function aiRoutes(
  app: FastifyInstance,
  opts: { config: AppConfig },
) {
  app.addHook("preHandler", app.requireAuth);

  app.get("/ai/status", async () => {
    return statusFor(await resolveSettings(app, opts.config));
  });

  app.post(
    "/ai/settings",
    { preHandler: [app.requireOwner] },
    async (request) => {
      const body = UpdateAiSettingsRequest.parse(request.body);
      const current = await app.db.query.aiSettings.findFirst();

      // apiKey semantics: omitted keeps the stored key, empty string clears it.
      const apiKey =
        body.apiKey === undefined
          ? (current?.apiKey ?? null)
          : body.apiKey.trim() === ""
            ? null
            : body.apiKey.trim();

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
    const aiConfig = configForQuality(settings, AI_FEATURE_QUALITY.chat);
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
          : `Can't reach Ollama at ${aiConfig.baseUrl}. Every other feature keeps working — check Settings → AI.`,
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
    const context = await buildFinancialContext(app.db);
    const history = await app.db.query.aiMessages.findMany({
      where: eq(aiMessages.conversationId, conversationId),
      orderBy: (t, { desc: d }) => [d(t.createdAt)],
      limit: HISTORY_LIMIT,
    });
    const messages: ChatMessage[] = [
      { role: "system", content: context },
      ...history.reverse().map((m) => ({ role: m.role, content: m.content })),
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
        await provider.streamChat(aiConfig, messages, (token) => {
          assistantText += token;
          writeLine({ token });
        });
        await app.db
          .insert(aiMessages)
          .values({ conversationId, role: "assistant", content: assistantText });
        await app.db
          .update(aiConversations)
          .set({ updatedAt: new Date() })
          .where(eq(aiConversations.id, conversationId));
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
