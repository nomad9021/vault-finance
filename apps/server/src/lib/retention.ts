import { and, isNotNull, lt, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { deviceSessions, memberInvites, trustedDevices } from "../db/schema.js";
import { SESSION_IDLE_DAYS } from "../modules/auth/service.js";

/**
 * Deletes sign-in records once they're no longer needed: ended or idle
 * sessions, approval requests nobody acted on, revoked devices, and used or
 * expired invites. Each is kept KEEP_DAYS after it stopped mattering, so the
 * "Devices" screen can still show what happened recently.
 *
 * Financial data is never touched here — that's yours to keep or delete.
 */
const KEEP_DAYS = 30;
const DAY_MS = 86_400_000;

export async function purgeExpiredRecords(app: FastifyInstance): Promise<{ sessions: number; devices: number; invites: number }> {
  const now = Date.now();
  const keepCutoff = new Date(now - KEEP_DAYS * DAY_MS);
  const idleCutoff = new Date(now - (SESSION_IDLE_DAYS + KEEP_DAYS) * DAY_MS);

  const sessions = await app.db
    .delete(deviceSessions)
    .where(
      or(
        and(isNotNull(deviceSessions.revokedAt), lt(deviceSessions.revokedAt, keepCutoff)),
        lt(deviceSessions.lastUsedAt, idleCutoff),
      ),
    )
    .returning({ id: deviceSessions.id });

  const devices = await app.db
    .delete(trustedDevices)
    .where(
      or(
        and(isNotNull(trustedDevices.revokedAt), lt(trustedDevices.revokedAt, keepCutoff)),
        and(sql`${trustedDevices.status} <> 'approved'`, lt(trustedDevices.requestedAt, keepCutoff)),
      ),
    )
    .returning({ id: trustedDevices.id });

  const invites = await app.db
    .delete(memberInvites)
    .where(
      or(
        lt(memberInvites.expiresAt, keepCutoff),
        and(isNotNull(memberInvites.acceptedAt), lt(memberInvites.acceptedAt, keepCutoff)),
      ),
    )
    .returning({ id: memberInvites.id });

  return { sessions: sessions.length, devices: devices.length, invites: invites.length };
}

/** Runs the purge shortly after boot, then daily. */
export function startRetention(app: FastifyInstance): void {
  const tick = () => {
    void purgeExpiredRecords(app)
      .then((n) => {
        if (n.sessions + n.devices + n.invites > 0) app.log.info(n, "deleted expired sign-in records");
      })
      .catch((err) => app.log.error({ err }, "retention purge failed"));
  };
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, DAY_MS);
  first.unref();
  timer.unref();
  app.addHook("onClose", async () => {
    clearTimeout(first);
    clearInterval(timer);
  });
}
