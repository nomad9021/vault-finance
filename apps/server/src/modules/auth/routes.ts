import {
  CreateDeviceKeyRequest,
  DeviceKeyLoginRequest,
  LoginByIdRequest,
  LoginRequest,
  LogoutRequest,
  RefreshRequest,
  TotpDisableRequest,
  TotpEnableRequest,
  type CreateDeviceKeyResponse,
  type DeviceKeyListResponse,
  type LoginResponse,
  type ProfilesResponse,
  type SessionListResponse,
  type TokenPair,
  type TotpSetupResponse,
  type TotpStatusResponse,
} from "@vault/shared";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { notFound, rateLimited } from "../../errors.js";
import { META_KEYS, readMeta } from "../../lib/app-meta.js";
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

  app.get("/auth/profiles", async (): Promise<ProfilesResponse> => {
    return {
      profiles: await authService.listProfiles(app.db),
      householdName: await readMeta(app.db, META_KEYS.householdName),
    };
  });

  app.post("/auth/login", async (request, reply) => {
    // The desktop login screen sends userId (profile picker, per the design);
    // email login remains for scripts and recovery.
    const body = z.union([LoginRequest, LoginByIdRequest]).parse(request.body);
    const identifier = "email" in body ? body.email.toLowerCase() : body.userId;
    if (!allowLogin(`${request.ip}:${identifier}`)) {
      throw rateLimited();
    }

    const result = await authService.login(app.db, {
      ...("email" in body ? { email: body.email } : { userId: body.userId }),
      password: body.password,
      deviceName: body.deviceName,
      platform: body.platform,
      ipAddress: request.ip ?? null,
      ...(body.totpCode ? { totpCode: body.totpCode } : {}),
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

  app.post("/auth/login/device-key", async (request, reply) => {
    const body = DeviceKeyLoginRequest.parse(request.body);
    // Keyed on the key id (the part before the dot), same window as passwords.
    if (!allowLogin(`${request.ip}:device-key:${body.key.split(".")[0]}`)) {
      throw rateLimited();
    }
    const result = await authService.loginWithDeviceKey(app.db, {
      key: body.key,
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

  // ── Device keys (biometric sign-in) ──
  app.get(
    "/auth/device-keys",
    { preHandler: [app.requireAuth] },
    async (request): Promise<DeviceKeyListResponse> => ({
      keys: await authService.listDeviceKeys(app.db, request.auth!.userId),
    }),
  );

  app.post("/auth/device-keys", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const body = CreateDeviceKeyRequest.parse(request.body);
    const created: CreateDeviceKeyResponse = await authService.createDeviceKey(
      app.db,
      request.auth!.userId,
      body,
    );
    return reply.status(201).send(created);
  });

  app.delete<{ Params: { id: string } }>(
    "/auth/device-keys/:id",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      await authService.revokeDeviceKey(app.db, request.auth!.userId, request.params.id);
      return reply.status(204).send();
    },
  );

  // ── Two-factor authentication (TOTP) ──
  app.get(
    "/auth/2fa/status",
    { preHandler: [app.requireAuth] },
    async (request): Promise<TotpStatusResponse> => authService.totpStatus(app.db, request.auth!.userId),
  );

  app.post(
    "/auth/2fa/setup",
    { preHandler: [app.requireAuth] },
    async (request): Promise<TotpSetupResponse> => authService.startTotpSetup(app.db, request.auth!.userId),
  );

  app.post("/auth/2fa/enable", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const body = TotpEnableRequest.parse(request.body);
    await authService.enableTotp(app.db, request.auth!.userId, body.code);
    return reply.status(204).send();
  });

  app.post("/auth/2fa/disable", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const body = TotpDisableRequest.parse(request.body);
    await authService.disableTotp(app.db, request.auth!.userId, body.password);
    return reply.status(204).send();
  });

  app.get("/me", { preHandler: [app.requireAuth] }, async (request) => {
    const auth = request.auth!;
    const user = await app.db.query.users.findFirst({
      where: (t, { eq }) => eq(t.id, auth.userId),
    });
    if (!user) throw notFound("User");
    return toApiUser(user);
  });
}
