import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { and, eq, isNull } from "drizzle-orm";
import type { Platform, User } from "@vault/shared";
import { deviceSessions, users } from "../../db/schema.js";
import type { Db } from "../../plugins/db.js";
import { AppError } from "../../errors.js";
import {
  invalidCredentials,
  notFound,
  refreshTokenReused,
  sessionRevoked,
  totpInvalid,
  totpRequired,
} from "../../errors.js";
import { decryptSecret, encryptSecret } from "../../secret-crypto.js";
import { generateTotpSecret, otpauthUri, verifyTotp } from "./totp.js";

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
): Promise<Array<{ id: string; displayName: string; avatarColor: string }>> {
  const rows = await db.query.users.findMany({
    columns: { id: true, displayName: true, avatarColor: true },
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
  const ok = await argon2
    .verify(user?.passwordHash ?? DUMMY_HASH, input.password)
    .catch(() => false);
  if (!user || !ok) throw invalidCredentials();

  // Two-factor gate: once enabled, a valid current code is required. Password
  // is verified first (above) so a missing/expired code never reveals whether
  // the password was right.
  if (user.totpEnabled) {
    if (!input.totpCode) throw totpRequired();
    if (!verifyTotp(decryptSecret(user.totpSecret) ?? "", input.totpCode)) throw totpInvalid();
  }

  const [session] = await db
    .insert(deviceSessions)
    .values({
      userId: user.id,
      deviceName: input.deviceName,
      platform: input.platform,
      refreshTokenHash: "pending", // replaced below once we know the session id
      ipAddress: input.ipAddress,
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

export interface RefreshResult {
  user: typeof users.$inferSelect;
  sessionId: string;
  refreshToken: string;
}

export async function refresh(db: Db, presentedToken: string): Promise<RefreshResult> {
  const parts = splitRefreshToken(presentedToken);
  if (!parts) throw invalidCredentials();

  const session = await db.query.deviceSessions.findFirst({
    where: eq(deviceSessions.id, parts.sessionId),
  });
  if (!session) throw invalidCredentials();
  if (session.revokedAt) throw sessionRevoked();

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
    .returning({ id: deviceSessions.id });
  if (!updated) throw notFound("Session");
}
