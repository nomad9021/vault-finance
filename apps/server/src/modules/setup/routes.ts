import {
  SetupCompleteRequest,
  type SetupStatusResponse,
} from "@vault/shared";
import argon2 from "argon2";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { aiSettings, users } from "../../db/schema.js";
import { seedDefaultCategories } from "../../db/seed-categories.js";
import { AppError } from "../../errors.js";
import type { AppConfig } from "../../config.js";

/** Setup is complete exactly when an owner user exists — no separate flag to drift. */
async function needsSetup(app: FastifyInstance): Promise<boolean> {
  const [row] = await app.db
    .select({ count: sql<number>`count(*)::int` })
    .from(users);
  return (row?.count ?? 0) === 0;
}

export default async function setupRoutes(
  app: FastifyInstance,
  opts: { config: AppConfig },
) {
  app.get("/setup/status", async (): Promise<SetupStatusResponse> => {
    return { needsSetup: await needsSetup(app) };
  });

  app.post("/setup/complete", async (request, reply) => {
    if (!(await needsSetup(app))) {
      throw new AppError(
        "SETUP_ALREADY_COMPLETE",
        409,
        "This server has already been set up.",
      );
    }

    const body = SetupCompleteRequest.parse(request.body);

    await app.db.transaction(async (tx) => {
      await tx.insert(users).values({
        email: body.ownerEmail.trim().toLowerCase(),
        passwordHash: await argon2.hash(body.ownerPassword),
        displayName: body.ownerDisplayName,
        avatarColor: "#9184d9", // Nocturne accent — matches the design's default avatar tint
        role: "owner",
      });

      const ai = body.aiConfig;
      await tx.insert(aiSettings).values({
        id: true,
        ollamaHost: ai?.ollamaHost ?? opts.config.ollama.host,
        ollamaPort: ai?.ollamaPort ?? opts.config.ollama.port,
        modelName: ai?.modelName ?? opts.config.ollama.model,
        enabled: ai?.enabled ?? true,
      });

      await seedDefaultCategories(tx);
    });

    return reply.status(201).send({ ok: true });
  });
}
