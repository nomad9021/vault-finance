import { randomBytes } from "node:crypto";
import type {
  InvitePreviewResponse,
  Member,
  MemberListResponse,
  PendingInvite,
} from "@vault/shared";
import argon2 from "argon2";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { memberInvites, users } from "../../db/schema.js";
import type { Db } from "../../plugins/db.js";
import { AppError, notFound } from "../../errors.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;

/** Invite tokens are `<inviteId>.<secret>` — the id makes lookup O(1), the secret is argon2-hashed at rest (mirrors auth refresh tokens). */
function mintInviteToken(inviteId: string): { token: string; secret: string } {
  const secret = randomBytes(32).toString("base64url");
  return { token: `${inviteId}.${secret}`, secret };
}

function splitInviteToken(token: string): { id: string; secret: string } | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const id = token.slice(0, dot);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  return { id, secret: token.slice(dot + 1) };
}

function toMember(row: typeof users.$inferSelect): Member {
  return {
    id: row.id,
    displayName: row.displayName,
    email: row.email,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listMembers(db: Db): Promise<MemberListResponse> {
  const userRows = await db.query.users.findMany({
    orderBy: (t, { asc: a }) => [a(t.createdAt)],
  });
  const inviteRows = await db
    .select()
    .from(memberInvites)
    .where(and(isNull(memberInvites.acceptedAt), gt(memberInvites.expiresAt, new Date())))
    .orderBy(asc(memberInvites.createdAt));

  const byId = new Map(userRows.map((u) => [u.id, u.displayName]));
  const invites: PendingInvite[] = inviteRows.map((i) => ({
    id: i.id,
    displayName: i.displayName,
    email: i.email,
    invitedByName: i.invitedByUserId ? byId.get(i.invitedByUserId) ?? null : null,
    createdAt: i.createdAt.toISOString(),
    expiresAt: i.expiresAt.toISOString(),
  }));

  return { members: userRows.map(toMember), invites };
}

async function assertEmailFree(db: Db, email: string): Promise<void> {
  const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (existing) {
    throw new AppError("VALIDATION_ERROR", 409, "Someone with that email already has an account.", {
      email: "Already in use",
    });
  }
}

export async function createInvite(
  db: Db,
  input: { displayName: string; email: string; invitedByUserId: string },
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const email = input.email.trim().toLowerCase();
  await assertEmailFree(db, email);

  // Replace any prior pending invite for the same address.
  await db.delete(memberInvites).where(eq(memberInvites.email, email));

  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const [row] = await db
    .insert(memberInvites)
    .values({
      email,
      displayName: input.displayName.trim(),
      tokenHash: "pending",
      invitedByUserId: input.invitedByUserId,
      expiresAt,
    })
    .returning({ id: memberInvites.id });
  if (!row) throw new Error("failed to create invite");

  const { token, secret } = mintInviteToken(row.id);
  await db
    .update(memberInvites)
    .set({ tokenHash: await argon2.hash(secret) })
    .where(eq(memberInvites.id, row.id));

  return { id: row.id, token, expiresAt };
}

export async function createMember(
  db: Db,
  input: { displayName: string; email: string; tempPassword: string },
): Promise<Member> {
  const email = input.email.trim().toLowerCase();
  await assertEmailFree(db, email);
  const [row] = await db
    .insert(users)
    .values({
      email,
      passwordHash: await argon2.hash(input.tempPassword),
      displayName: input.displayName.trim(),
      avatarColor: "#9184d9",
      role: "member",
    })
    .returning();
  if (!row) throw new Error("failed to create member");
  return toMember(row);
}

/** Remove a member account, or revoke a pending invite, by id. */
export async function removeMemberOrInvite(
  db: Db,
  id: string,
  requestingUserId: string,
): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (user) {
    if (user.id === requestingUserId) {
      throw new AppError("VALIDATION_ERROR", 400, "You can't remove your own account here.");
    }
    if (user.role === "owner") {
      throw new AppError("VALIDATION_ERROR", 400, "The household owner can't be removed.");
    }
    await db.delete(users).where(eq(users.id, id)); // device_sessions cascade
    return;
  }
  const [invite] = await db.delete(memberInvites).where(eq(memberInvites.id, id)).returning({
    id: memberInvites.id,
  });
  if (!invite) throw notFound("Member or invite");
}

async function loadValidInvite(db: Db, rawToken: string) {
  const parts = splitInviteToken(rawToken);
  if (!parts) throw notFound("Invite");
  const invite = await db.query.memberInvites.findFirst({
    where: eq(memberInvites.id, parts.id),
  });
  if (!invite || invite.acceptedAt || invite.expiresAt.getTime() < Date.now()) {
    throw notFound("Invite");
  }
  const ok = await argon2.verify(invite.tokenHash, parts.secret).catch(() => false);
  if (!ok) throw notFound("Invite");
  return invite;
}

export async function previewInvite(db: Db, rawToken: string): Promise<InvitePreviewResponse> {
  const invite = await loadValidInvite(db, rawToken);
  const inviter = invite.invitedByUserId
    ? await db.query.users.findFirst({ where: eq(users.id, invite.invitedByUserId) })
    : null;
  return {
    displayName: invite.displayName,
    email: invite.email,
    invitedByName: inviter?.displayName ?? null,
  };
}

export async function acceptInvite(
  db: Db,
  rawToken: string,
  password: string,
): Promise<void> {
  const invite = await loadValidInvite(db, rawToken);
  await assertEmailFree(db, invite.email);
  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      email: invite.email,
      passwordHash: await argon2.hash(password),
      displayName: invite.displayName,
      avatarColor: "#9184d9",
      role: invite.role,
    });
    await tx
      .update(memberInvites)
      .set({ acceptedAt: new Date() })
      .where(eq(memberInvites.id, invite.id));
  });
}
