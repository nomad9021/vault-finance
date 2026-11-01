import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Platform, User } from "@vault/shared";
import { deviceKeys, deviceSessions, trustedDevices, users } from "../../db/schema.js";
import type { Db } from "../../plugins/db.js";
import { AppError } from "../../errors.js";
import {
  accountLocked,
  invalidCredentials,
  notFound,
  refreshTokenReused,
  sessionRevoked,
  totpInvalid,
  totpRequired,
} from "../../errors.js";
import { decryptSecret, encryptSecret } from "../../secret-crypto.js";
import { generateTotpSecret, otpauthUri, verifyTotp } from "./totp.js";
import { adoptLegacySession, findApprovedDevice, gateDevice } from "../devices/service.js";

/**
 * Refresh tokens are `<sessionId>.<secret>`: the session id makes lookup O(1)
 * and — critically for ADR-0003 — lets us distinguish "replay of a rotated
 * token for a real session" (revoke the session, return REFRESH_TOKEN_REUSED)
 * from "random garbage" (plain 401).
 */
function mintRefreshToken(sessionId: string): { token: string; secret: string } {
  const secret = randomBytes(32).toString("base64url");
  return { token: `${sessionId}.${secret}`, secret };
}

function splitRefreshToken(token: string): { sessionId: string; secret: string } | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const sessionId = token.slice(0, dot);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    return null;
  }
  return { sessionId, secret: token.slice(dot + 1) };
}

export function toApiUser(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    avatarColor: row.avatarColor,
    avatarImage: row.avatarImage ?? null,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface LoginResult {
  user: typeof users.$inferSelect;
  sessionId: string;
  refreshToken: string;
}

/** Login-screen profile list — no auth, so no emails (ADR-0003 note in api-design.md). */
export async function listProfiles(
  db: Db,
): Promise<Array<{ id: string; displayName: string; avatarColor: string; avatarImage: string | null }>> {
  const rows = await db.query.users.findMany({
    columns: { id: true, displayName: true, avatarColor: true, avatarImage: true },
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });
  return rows;
}

export async function login(
  db: Db,
  input: {
    email?: string;
    userId?: string;
    password: string;
    deviceName: string;
    platform: Platform;
    ipAddress: string | null;
    totpCode?: string | undefined;
    deviceId?: string | undefined;
    deviceSecret?: string | undefined;
  },
): Promise<LoginResult> {
  const user = input.userId
    ? await db.query.users.findFirst({ where: eq(users.id, input.userId) })
    : await db.query.users.findFirst({
        where: eq(users.email, (input.email ?? "").trim().toLowerCase()),
      });
  // Verify against a constant dummy hash when the user doesn't exist so the
  // response time doesn't reveal which emails are registered.
  const DUMMY_HASH =
    "$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$Zm5vdF9hX3JlYWxfaGFzaF92YWx1ZQ";
  if (user?.lockedUntil && user.lockedUntil > new Date()) throw accountLocked(user.lockedUntil);
  const ok = await argon2
    .verify(user?.passwordHash ?? DUMMY_HASH, input.password)
    .catch(() => false);
  if (!user) throw invalidCredentials();
  if (!ok) {
    await recordFailedLogin(db, user);
    throw invalidCredentials();
  }

  // Two-factor gate: once enabled, a valid current code is required. Password
  // is verified first (above) so a missing/expired code never reveals whether
  // the password was right.
  if (user.totpEnabled) {
    if (!input.totpCode) throw totpRequired();
    if (!verifyTotp(decryptSecret(user.totpSecret) ?? "", input.totpCode)) {
      await recordFailedLogin(db, user);
      throw totpInvalid();
    }
  }
  if (user.failedLoginCount > 0 || user.lockedUntil) {
    await db.update(users).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, user.id));
  }

  // Device approval comes last, so a request only reaches approvers once the
  // password (and code) were right (ADR-0009).
  const trustedDeviceId = await gateDevice(db, user, input);
  return startSession(db, user, { ...input, trustedDeviceId });
}

/**
 * Account lockout. The per-IP limits in the rate-limit plugin don't stop
 * someone guessing one account's password from many addresses; this does.
 * After LOCKOUT_THRESHOLD wrong passwords or 2FA codes the account refuses
 * every sign-in for LOCKOUT_MINUTES, then the count starts over.
 */
export const LOCKOUT_THRESHOLD = 10;
export const LOCKOUT_MINUTES = 15;

async function recordFailedLogin(db: Db, user: typeof users.$inferSelect): Promise<void> {
  const [row] = await db
    .update(users)
    .set({ failedLoginCount: sql`${users.failedLoginCount} + 1` })
    .where(eq(users.id, user.id))
    .returning({ count: users.failedLoginCount });
  if ((row?.count ?? 0) >= LOCKOUT_THRESHOLD) {
    await db
      .update(users)
      .set({ failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60_000) })
      .where(eq(users.id, user.id));
  }
}

export async function startSession(
  db: Db,
  user: typeof users.$inferSelect,
  device: { deviceName: string; platform: Platform; ipAddress: string | null; trustedDeviceId: string },
): Promise<LoginResult> {
  const [session] = await db
    .insert(deviceSessions)
    .values({
      userId: user.id,
      deviceName: device.deviceName,
      platform: device.platform,
      refreshTokenHash: "pending", // replaced below once we know the session id
      ipAddress: device.ipAddress,
      trustedDeviceId: device.trustedDeviceId,
    })
    .returning({ id: deviceSessions.id });
  if (!session) throw new Error("failed to create device session");

  const { token, secret } = mintRefreshToken(session.id);
  await db
    .update(deviceSessions)
    .set({ refreshTokenHash: await argon2.hash(secret) })
    .where(eq(deviceSessions.id, session.id));

  return { user, sessionId: session.id, refreshToken: token };
}

// ── Device keys (biometric sign-in) ──
// Same `<id>.<secret>` shape as refresh tokens (see mintRefreshToken): the id
// makes lookup O(1), only the argon2 hash of the secret is stored. Each key is
// bound to the approved device whose session enrolled it, so it only works
// alongside that device's own identity and dies when the device is revoked.

export async function createDeviceKey(
  db: Db,
  userId: string,
  sessionId: string,
  device: { deviceName: string; platform: Platform },
): Promise<{ id: string; key: string }> {
  const session = await db.query.deviceSessions.findFirst({
    where: and(
      eq(deviceSessions.id, sessionId),
      eq(deviceSessions.userId, userId),
      isNull(deviceSessions.revokedAt),
    ),
  });
  const trusted = session?.trustedDeviceId
    ? await db.query.trustedDevices.findFirst({ where: eq(trustedDevices.id, session.trustedDeviceId) })
    : undefined;
  if (!session || !trusted || trusted.status !== "approved" || trusted.revokedAt) {
    throw sessionRevoked();
  }

  const secret = randomBytes(32).toString("base64url");
  const [row] = await db
    .insert(deviceKeys)
    .values({
      userId,
      deviceName: device.deviceName,
      platform: device.platform,
      secretHash: await argon2.hash(secret),
      trustedDeviceId: trusted.id,
    })
    .returning({ id: deviceKeys.id });
  if (!row) throw new Error("failed to create device key");
  return { id: row.id, key: `${row.id}.${secret}` };
}

export async function listDeviceKeys(db: Db, userId: string) {
  const rows = await db.query.deviceKeys.findMany({
    where: eq(deviceKeys.userId, userId),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
  return rows.map((k) => ({
    id: k.id,
    deviceName: k.deviceName,
    platform: k.platform,
    createdAt: k.createdAt.toISOString(),
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
  }));
}

export async function revokeDeviceKey(db: Db, userId: string, id: string): Promise<void> {
  const [deleted] = await db
    .delete(deviceKeys)
    .where(and(eq(deviceKeys.id, id), eq(deviceKeys.userId, userId)))
    .returning({ id: deviceKeys.id });
  if (!deleted) throw notFound("Device key");
}

/**
 * Sign in with a device key. The client only sends it after the OS confirmed
 * the device owner (biometric), so it stands in for password + TOTP — the
 * same trade-off passkeys make: possession of the enrolled device plus a
 * local biometric. It must arrive with the identity of the approved device it
 * is bound to, and it only reuses that approval — it never approves a device.
 * Anything the legitimate client can never get wrong (the key's secret, the
 * device it belongs to) deletes the key.
 */
export async function loginWithDeviceKey(
  db: Db,
  input: {
    key: string;
    deviceName: string;
    platform: Platform;
    ipAddress: string | null;
    deviceId?: string | undefined;
    deviceSecret?: string | undefined;
  },
): Promise<LoginResult> {
  const parts = splitRefreshToken(input.key);
  if (!parts) throw invalidCredentials();
  const row = await db.query.deviceKeys.findFirst({ where: eq(deviceKeys.id, parts.sessionId) });
  if (!row) throw invalidCredentials();
  const ok = await argon2.verify(row.secretHash, parts.secret).catch(() => false);
  if (!ok) {
    await db.delete(deviceKeys).where(eq(deviceKeys.id, row.id));
    throw invalidCredentials();
  }
  const user = await db.query.users.findFirst({ where: eq(users.id, row.userId) });
  if (!user) throw invalidCredentials();
  // No identity sent: a client that failed to load its own, not a wrong one.
  // Refuse, but keep the key so biometric sign-in works once it can load again.
  if (!input.deviceId || !input.deviceSecret) throw invalidCredentials();
  const device = await findApprovedDevice(db, user.id, input);
  // Keys enrolled before binding have no device yet; they adopt the approved
  // device they're presented with, which still has to prove its own secret.
  if (!device || (row.trustedDeviceId && row.trustedDeviceId !== device.id)) {
    await db.delete(deviceKeys).where(eq(deviceKeys.id, row.id));
    throw invalidCredentials();
  }
  await db
    .update(deviceKeys)
    .set({ lastUsedAt: new Date(), trustedDeviceId: device.id })
    .where(eq(deviceKeys.id, row.id));
  await db
    .update(trustedDevices)
    .set({ lastSeenAt: new Date(), deviceName: input.deviceName })
    .where(eq(trustedDevices.id, device.id));
  return startSession(db, user, { ...input, trustedDeviceId: device.id });
}

// ── Two-factor authentication (TOTP) ──

export async function totpStatus(db: Db, userId: string): Promise<{ enabled: boolean }> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  return { enabled: user?.totpEnabled ?? false };
}

/** Generate + store a pending secret and return it for enrollment. */
export async function startTotpSetup(
  db: Db,
  userId: string,
): Promise<{ secret: string; otpauthUri: string }> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw notFound("User");
  if (user.totpEnabled) {
    throw new AppError("VALIDATION_ERROR", 409, "Two-factor is already on — turn it off to re-enroll.");
  }
  const secret = generateTotpSecret();
  await db
    .update(users)
    .set({ totpSecret: encryptSecret(secret), updatedAt: new Date() })
    .where(eq(users.id, userId));
  return { secret, otpauthUri: otpauthUri(secret, user.email) };
}

/** Confirm a code against the pending secret and turn 2FA on. */
export async function enableTotp(db: Db, userId: string, code: string): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user?.totpSecret) {
    throw new AppError("VALIDATION_ERROR", 400, "Start two-factor setup first.");
  }
  if (user.totpEnabled) return;
  if (!verifyTotp(decryptSecret(user.totpSecret), code)) throw totpInvalid();
  await db.update(users).set({ totpEnabled: true, updatedAt: new Date() }).where(eq(users.id, userId));
}

/** Turn 2FA off — re-auth with the account password. */
export async function disableTotp(db: Db, userId: string, password: string): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw notFound("User");
  const ok = await argon2.verify(user.passwordHash, password).catch(() => false);
  if (!ok) throw invalidCredentials();
  await db
    .update(users)
    .set({ totpEnabled: false, totpSecret: null, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

/**
 * Change your own password. A leaked password is the reason to do this, so it
 * also ends every other sign-in and deletes every other device's biometric
 * key — whoever had the old password keeps nothing. Wrong current passwords
 * count towards the account lockout like failed sign-ins.
 */
export async function changePassword(
  db: Db,
  userId: string,
  currentSessionId: string,
  input: { currentPassword: string; newPassword: string },
): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw notFound("User");
  if (user.lockedUntil && user.lockedUntil > new Date()) throw accountLocked(user.lockedUntil);
  const ok = await argon2.verify(user.passwordHash, input.currentPassword).catch(() => false);
  if (!ok) {
    await recordFailedLogin(db, user);
    throw invalidCredentials();
  }
  if (input.newPassword === input.currentPassword) {
    throw new AppError("VALIDATION_ERROR", 400, "Choose a password you haven't been using.");
  }

  const current = await db.query.deviceSessions.findFirst({ where: eq(deviceSessions.id, currentSessionId) });
  const now = new Date();
  const passwordHash = await argon2.hash(input.newPassword);
  // All or nothing: a new password that leaves old sign-ins alive is the failure this prevents.
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash, failedLoginCount: 0, lockedUntil: null, updatedAt: now })
      .where(eq(users.id, userId));
    await tx
      .update(deviceSessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(deviceSessions.userId, userId),
          isNull(deviceSessions.revokedAt),
          sql`${deviceSessions.id} <> ${currentSessionId}`,
        ),
      );
    await tx
      .delete(deviceKeys)
      .where(
        and(
          eq(deviceKeys.userId, userId),
          current?.trustedDeviceId
            ? sql`${deviceKeys.trustedDeviceId} IS DISTINCT FROM ${current.trustedDeviceId}`
            : undefined,
        ),
      );
    // Sign-in requests made with the old password die too: open ones are
    // denied, and an approved one that hasn't collected its session yet must
    // sign in again (with the new password).
    await tx
      .update(trustedDevices)
      .set({ status: "denied", approvalCode: null, expiresAt: null })
      .where(and(eq(trustedDevices.userId, userId), eq(trustedDevices.status, "pending")));
    await tx
      .update(trustedDevices)
      .set({ loginReady: false })
      .where(and(eq(trustedDevices.userId, userId), eq(trustedDevices.loginReady, true)));
  });
}

/** Days a device may go unused before its sign-in ends. */
export const SESSION_IDLE_DAYS = 30;

export interface RefreshResult {
  user: typeof users.$inferSelect;
  sessionId: string;
  refreshToken: string;
}

export async function refresh(
  db: Db,
  presentedToken: string,
  identity: { deviceId?: string | undefined; deviceSecret?: string | undefined } = {},
): Promise<RefreshResult> {
  const parts = splitRefreshToken(presentedToken);
  if (!parts) throw invalidCredentials();

  const session = await db.query.deviceSessions.findFirst({
    where: eq(deviceSessions.id, parts.sessionId),
  });
  if (!session) throw invalidCredentials();
  if (session.revokedAt) throw sessionRevoked();
  // A sign-in unused for SESSION_IDLE_DAYS ends: a refresh token copied off a
  // device nobody uses any more stops working on its own.
  if (session.lastUsedAt.getTime() < Date.now() - SESSION_IDLE_DAYS * 86_400_000) {
    await db.update(deviceSessions).set({ revokedAt: new Date() }).where(eq(deviceSessions.id, session.id));
    throw sessionRevoked();
  }

  const matches = await argon2
    .verify(session.refreshTokenHash, parts.secret)
    .catch(() => false);
  if (!matches) {
    // A real session id with a wrong secret is almost certainly a replayed
    // pre-rotation token: revoke the whole session (ADR-0003).
    await db
      .update(deviceSessions)
      .set({ revokedAt: new Date() })
      .where(eq(deviceSessions.id, session.id));
    throw refreshTokenReused();
  }

  const user = await db.query.users.findFirst({ where: eq(users.id, session.userId) });
  if (!user) throw invalidCredentials();

  // Rotate: the presented secret stops working the moment the new hash lands.
  const { token, secret } = mintRefreshToken(session.id);
  await db
    .update(deviceSessions)
    .set({ refreshTokenHash: await argon2.hash(secret), lastUsedAt: new Date() })
    .where(eq(deviceSessions.id, session.id));
  await adoptLegacySession(db, session, identity);

  return { user, sessionId: session.id, refreshToken: token };
}

export async function logout(db: Db, presentedToken: string): Promise<void> {
  const parts = splitRefreshToken(presentedToken);
  if (!parts) return; // logout is idempotent — nothing to revoke is success
  await db
    .update(deviceSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(deviceSessions.id, parts.sessionId), isNull(deviceSessions.revokedAt)));
}

export async function listSessions(
  db: Db,
  userId: string,
  currentSessionId: string,
): Promise<
  Array<{
    id: string;
    deviceName: string;
    platform: Platform;
    ipAddress: string | null;
    createdAt: string;
    lastUsedAt: string;
    isCurrent: boolean;
  }>
> {
  const rows = await db.query.deviceSessions.findMany({
    where: and(eq(deviceSessions.userId, userId), isNull(deviceSessions.revokedAt)),
    orderBy: (t, { desc }) => [desc(t.lastUsedAt)],
  });
  return rows.map((s) => ({
    id: s.id,
    deviceName: s.deviceName,
    platform: s.platform,
    ipAddress: s.ipAddress,
    createdAt: s.createdAt.toISOString(),
    lastUsedAt: s.lastUsedAt.toISOString(),
    isCurrent: s.id === currentSessionId,
  }));
}

export async function revokeSession(
  db: Db,
  userId: string,
  sessionId: string,
): Promise<void> {
  const [updated] = await db
    .update(deviceSessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(deviceSessions.id, sessionId),
        eq(deviceSessions.userId, userId),
        isNull(deviceSessions.revokedAt),
      ),
    )
    .returning({ id: deviceSessions.trustedDeviceId });
  if (!updated) throw notFound("Session");
  // Signing a device out remotely also turns off its biometric sign-in, so it
  // needs the password again rather than a fingerprint.
  if (updated.id) await db.delete(deviceKeys).where(eq(deviceKeys.trustedDeviceId, updated.id));
}
