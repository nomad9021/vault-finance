import {
  CreateDeviceKeyRequest,
  DeviceKeyLoginRequest,
  LoginByIdRequest,
  LoginRequest,
  LogoutRequest,
  RefreshRequest,
  TotpDisableRequest,
  TotpEnableRequest,
  UpdateMeRequest,
  UserPreferences,
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
import { eq } from "drizzle-orm";
import { users } from "../../db/schema.js";
import { AppError, notFound, rateLimited } from "../../errors.js";
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
      deviceId: body.deviceId,
      deviceSecret: body.deviceSecret,
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
      deviceId: body.deviceId,
      deviceSecret: body.deviceSecret,
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
    const result = await authService.refresh(app.db, body.refreshToken, body);

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

  // Your own name, colour and profile picture. (Passwords change through the
  // password routes, which ask for the current one.)
  app.patch("/me", { preHandler: [app.requireAuth] }, async (request) => {
    const body = UpdateMeRequest.parse(request.body);
    if (body.newPassword || body.currentPassword) {
      throw new AppError("VALIDATION_ERROR", 400, "Change your password in Settings → Security.");
    }
    if (body.avatarImage && !looksLikeImage(body.avatarImage)) {
      throw new AppError("VALIDATION_ERROR", 400, "That file isn't a JPEG, PNG or WebP picture.");
    }
    const [row] = await app.db
      .update(users)
      .set({
        ...(body.displayName !== undefined ? { displayName: body.displayName.trim() } : {}),
        ...(body.avatarColor !== undefined ? { avatarColor: body.avatarColor } : {}),
        ...(body.avatarImage !== undefined ? { avatarImage: body.avatarImage } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, request.auth!.userId))
      .returning();
    if (!row) throw notFound("User");
    return toApiUser(row);
  });

  app.get("/me/preferences", { preHandler: [app.requireAuth] }, async (request) => {
    const user = await app.db.query.users.findFirst({ where: (t, { eq: e }) => e(t.id, request.auth!.userId) });
    if (!user) throw notFound("User");
    return UserPreferences.catch({}).parse(user.preferences ?? {});
  });

  app.put("/me/preferences", { preHandler: [app.requireAuth] }, async (request) => {
    const body = UserPreferences.parse(request.body);
    const user = await app.db.query.users.findFirst({ where: (t, { eq: e }) => e(t.id, request.auth!.userId) });
    if (!user) throw notFound("User");
    const merged = { ...(user.preferences ?? {}), ...body };
    await app.db.update(users).set({ preferences: merged, updatedAt: new Date() }).where(eq(users.id, user.id));
    return UserPreferences.parse(merged);
  });
}

/** The decoded bytes start like a real JPEG, PNG or WebP file. */
export function looksLikeImage(dataUrl: string): boolean {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1, dataUrl.indexOf(",") + 1 + 24);
  const head = Buffer.from(b64, "base64");
  const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const png = head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const webp = head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP";
  return jpeg || png || webp;
}
