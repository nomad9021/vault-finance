import {
  LoginRequest,
  LogoutRequest,
  RefreshRequest,
  type LoginResponse,
  type SessionListResponse,
  type TokenPair,
} from "@vault/shared";
import type { FastifyInstance } from "fastify";
import { notFound, rateLimited } from "../../errors.js";
import * as authService from "./service.js";
import { toApiUser } from "./service.js";

/**
 * In-memory login rate limiter: 10 attempts per identifier per 15 minutes.
 * Redis-backed limiting can replace this transparently later; for a
 * single-household server an in-memory window is proportionate.
 */
function makeRateLimiter(max = 10, windowMs = 15 * 60_000) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const now = Date.now();
    const windowStart = now - windowMs;
    const list = (hits.get(key) ?? []).filter((t) => t > windowStart);
    list.push(now);
    hits.set(key, list);
    if (hits.size > 10_000) {
      // Bounded memory: drop entries whose window has fully expired.
      for (const [k, v] of hits) {
        if (v.every((t) => t <= windowStart)) hits.delete(k);
      }
    }
    return list.length <= max;
  };
}

export default async function authRoutes(app: FastifyInstance) {
  const allowLogin = makeRateLimiter();

  app.post("/auth/login", async (request, reply) => {
    const body = LoginRequest.parse(request.body);
    if (!allowLogin(`${request.ip}:${body.email.toLowerCase()}`)) {
      throw rateLimited();
    }

    const result = await authService.login(app.db, {
      email: body.email,
      password: body.password,
      deviceName: body.deviceName,
      platform: body.platform,
      ipAddress: request.ip ?? null,
    });

    const accessToken = await app.signAccessToken({
      sub: result.user.id,
      sid: result.sessionId,
      role: result.user.role,
    });

    const response: LoginResponse = {
      accessToken,
      refreshToken: result.refreshToken,
      user: toApiUser(result.user),
    };
    return reply.status(200).send(response);
  });

  app.post("/auth/refresh", async (request, reply) => {
    const body = RefreshRequest.parse(request.body);
    const result = await authService.refresh(app.db, body.refreshToken);

    const accessToken = await app.signAccessToken({
      sub: result.user.id,
      sid: result.sessionId,
      role: result.user.role,
    });

    const response: TokenPair = {
      accessToken,
      refreshToken: result.refreshToken,
    };
    return reply.status(200).send(response);
  });

  app.post("/auth/logout", async (request, reply) => {
    const body = LogoutRequest.parse(request.body);
    await authService.logout(app.db, body.refreshToken);
    return reply.status(204).send();
  });

  app.get(
    "/auth/sessions",
    { preHandler: [app.requireAuth] },
    async (request): Promise<SessionListResponse> => {
      const auth = request.auth!;
      const sessions = await authService.listSessions(
        app.db,
        auth.userId,
        auth.deviceSessionId,
      );
      return { sessions };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/auth/sessions/:id",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      const auth = request.auth!;
      await authService.revokeSession(app.db, auth.userId, request.params.id);
      return reply.status(204).send();
    },
  );

  app.get("/me", { preHandler: [app.requireAuth] }, async (request) => {
    const auth = request.auth!;
    const user = await app.db.query.users.findFirst({
      where: (t, { eq }) => eq(t.id, auth.userId),
    });
    if (!user) throw notFound("User");
    return toApiUser(user);
  });
}
