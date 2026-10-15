import {
  ApproveDeviceRequest,
  DeviceApprovalSettings,
  DeviceApprovalStatusRequest,
  type DeviceApprovalStatusResponse,
  type PendingApprovalListResponse,
  type TrustedDeviceListResponse,
} from "@vault/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { deviceSessions, users } from "../../db/schema.js";
import { rateLimited } from "../../errors.js";
import { startSession, toApiUser } from "../auth/service.js";
import * as devices from "./service.js";

/** Small sliding-window limiter for the unauthenticated poll endpoint. */
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string) => {
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
    list.push(now);
    hits.set(key, list);
    if (hits.size > 10_000) hits.clear();
    return list.length <= max;
  };
}

/** Device approval endpoints (ADR-0009). */
export default async function deviceRoutes(app: FastifyInstance) {
  // Waiting devices poll every few seconds for up to 15 minutes.
  const allowPoll = limiter(60, 60_000);

  app.post("/auth/device-approval/status", async (request): Promise<DeviceApprovalStatusResponse> => {
    const body = DeviceApprovalStatusRequest.parse(request.body);
    if (!allowPoll(`${request.ip}:${body.approvalId}`)) throw rateLimited();
    const result = await devices.pollApproval(app.db, body);
    if (result.status !== "approved") return result;

    const user = await app.db.query.users.findFirst({ where: eq(users.id, result.userId) });
    if (!user) return { status: "expired" };
    const session = await startSession(app.db, user, {
      deviceName: result.deviceName,
      platform: result.platform,
      ipAddress: request.ip ?? null,
      trustedDeviceId: result.trustedDeviceId,
    });
    const accessToken = await app.signAccessToken({ sub: user.id, sid: session.sessionId, role: user.role });
    return {
      status: "approved",
      login: { accessToken, refreshToken: session.refreshToken, user: toApiUser(user) },
    };
  });

  const approver = (request: FastifyRequest) => ({ userId: request.auth!.userId, role: request.auth!.role });

  app.get("/devices/approvals", { preHandler: [app.requireAuth] }, async (request): Promise<PendingApprovalListResponse> => {
    return { approvals: await devices.listPending(app.db, approver(request)) };
  });

  app.post<{ Params: { id: string } }>(
    "/devices/approvals/:id/approve",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      const body = ApproveDeviceRequest.parse(request.body);
      await devices.approveFromDevice(app.db, approver(request), request.params.id, body.code);
      request.log.info({ approvalId: request.params.id, by: request.auth!.userId }, "device approved");
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    "/devices/approvals/:id/deny",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      await devices.deny(app.db, approver(request), request.params.id);
      return reply.status(204).send();
    },
  );

  app.get("/devices", { preHandler: [app.requireAuth] }, async (request): Promise<TrustedDeviceListResponse> => {
    const session = await app.db.query.deviceSessions.findFirst({
      where: eq(deviceSessions.id, request.auth!.deviceSessionId),
    });
    return { devices: await devices.listTrusted(app.db, approver(request), session?.trustedDeviceId ?? null) };
  });

  app.delete<{ Params: { id: string } }>("/devices/:id", { preHandler: [app.requireAuth] }, async (request, reply) => {
    await devices.revokeDevice(app.db, approver(request), request.params.id);
    return reply.status(204).send();
  });

  app.get("/devices/approval-settings", { preHandler: [app.requireAuth] }, async () => devices.getMethods(app.db));

  app.put("/devices/approval-settings", { preHandler: [app.requireOwner] }, async (request) => {
    return devices.setMethods(app.db, DeviceApprovalSettings.parse(request.body));
  });
}
