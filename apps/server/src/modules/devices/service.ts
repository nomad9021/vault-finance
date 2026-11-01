import { randomInt, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { ApprovedVia, Platform, PendingApproval, TrustedDevice, UserRole } from "@vault/shared";
import { deviceKeys, deviceSessions, trustedDevices, users } from "../../db/schema.js";
import type { Db } from "../../plugins/db.js";
import {
  AppError,
  deviceApprovalRequired,
  deviceNotTrusted,
  forbidden,
  notFound,
  rateLimited,
} from "../../errors.js";
import { readMeta, writeMeta } from "../../lib/app-meta.js";

/**
 * Device approval (ADR-0009). A correct password (and TOTP code) is not enough
 * on its own: the device has to be one the server has approved. Approval is
 * by number matching from an already-trusted device, or on the server console
 * (`vault approve <code>`); the owner chooses which of those are allowed.
 */

const PENDING_TTL_MS = 15 * 60_000;
/** Max open requests per user, so a leaked password can't flood approvers. */
const MAX_PENDING_PER_USER = 5;
/** Wrong codes before a request is auto-denied. */
const MAX_CODE_ATTEMPTS = 5;

const METHODS_KEY = "device_approval_methods";

export interface ApprovalMethods {
  trustedDevice: boolean;
  serverConsole: boolean;
}

export async function getMethods(db: Db): Promise<ApprovalMethods> {
  const raw = await readMeta(db, METHODS_KEY);
  try {
    const v = raw ? (JSON.parse(raw) as Partial<ApprovalMethods>) : {};
    const m = { trustedDevice: v.trustedDevice !== false, serverConsole: v.serverConsole !== false };
    // Never both off — that would make new devices impossible to approve.
    return m.trustedDevice || m.serverConsole ? m : { trustedDevice: true, serverConsole: true };
  } catch {
    return { trustedDevice: true, serverConsole: true };
  }
}

export async function setMethods(db: Db, m: ApprovalMethods): Promise<ApprovalMethods> {
  if (!m.trustedDevice && !m.serverConsole) {
    throw new AppError("VALIDATION_ERROR", 400, "Keep at least one way to approve new devices turned on.");
  }
  await writeMeta(db, METHODS_KEY, JSON.stringify(m));
  return m;
}

const methodsString = (m: ApprovalMethods) =>
  [m.trustedDevice && "trustedDevice", m.serverConsole && "serverConsole"].filter(Boolean).join(",");

type Row = typeof trustedDevices.$inferSelect;

export interface DeviceInput {
  deviceId?: string | undefined;
  deviceSecret?: string | undefined;
  deviceName: string;
  platform: Platform;
  ipAddress: string | null;
}

async function verifySecret(row: Row, secret: string): Promise<boolean> {
  return argon2.verify(row.secretHash, secret).catch(() => false);
}

/** A 6-digit code no other open request is using (so the console can find it by code). */
async function freshCode(db: Db): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const clash = await db.query.trustedDevices.findFirst({
      where: and(
        eq(trustedDevices.approvalCode, code),
        eq(trustedDevices.status, "pending"),
        gt(trustedDevices.expiresAt, new Date()),
      ),
    });
    if (!clash) return code;
  }
  throw new Error("couldn't allocate an approval code");
}

async function upsertDevice(
  db: Db,
  userId: string,
  input: DeviceInput & { deviceId: string; deviceSecret: string },
  values: Partial<typeof trustedDevices.$inferInsert>,
): Promise<Row> {
  const base = {
    userId,
    deviceId: input.deviceId,
    secretHash: await argon2.hash(input.deviceSecret),
    deviceName: input.deviceName,
    platform: input.platform,
    requestIp: input.ipAddress,
    status: "pending" as const,
    approvalCode: null,
    codeAttempts: 0,
    requestedAt: new Date(),
    expiresAt: null,
    approvedAt: null,
    approvedVia: null,
    approvedBy: null,
    loginReady: false,
    revokedAt: null,
    ...values,
  };
  const { userId: _u, deviceId: _d, ...update } = base;
  const [row] = await db
    .insert(trustedDevices)
    .values(base)
    .onConflictDoUpdate({ target: [trustedDevices.userId, trustedDevices.deviceId], set: update })
    .returning();
  if (!row) throw new Error("failed to store device");
  return row;
}

function challenge(row: Row, methods: ApprovalMethods): never {
  throw deviceApprovalRequired({
    approvalId: row.id,
    code: row.approvalCode!,
    expiresAt: row.expiresAt!.toISOString(),
    methods: methodsString(methods),
  });
}

const approved = (via: ApprovedVia, by: string | null = null) => ({
  status: "approved" as const,
  approvedAt: new Date(),
  approvedVia: via,
  approvedBy: by,
  lastSeenAt: new Date(),
});

/**
 * The approved, unrevoked device this identity proves, or null. Used by
 * biometric sign-in, which may only ever reuse an existing approval — never
 * create one.
 */
export async function findApprovedDevice(
  db: Db,
  userId: string,
  input: { deviceId?: string | undefined; deviceSecret?: string | undefined },
): Promise<Row | null> {
  if (!input.deviceId || !input.deviceSecret) return null;
  const row = await db.query.trustedDevices.findFirst({
    where: and(eq(trustedDevices.userId, userId), eq(trustedDevices.deviceId, input.deviceId)),
  });
  if (!row || row.status !== "approved" || row.revokedAt) return null;
  return (await verifySecret(row, input.deviceSecret)) ? row : null;
}

/**
 * The gate every sign-in passes after the user is authenticated. Returns the
 * trusted-device id to bind the new session to, or throws
 * DEVICE_APPROVAL_REQUIRED with a code for the device to show.
 */
export async function gateDevice(
  db: Db,
  user: { id: string; role: UserRole },
  input: DeviceInput,
): Promise<string> {
  if (!input.deviceId || !input.deviceSecret) {
    throw deviceNotTrusted(
      "This server requires new devices to be approved, and this version of the app can't do that. Update Vault Finance and sign in again.",
    );
  }
  const identity = { ...input, deviceId: input.deviceId, deviceSecret: input.deviceSecret };
  const row = await db.query.trustedDevices.findFirst({
    where: and(eq(trustedDevices.userId, user.id), eq(trustedDevices.deviceId, input.deviceId)),
  });

  if (row && row.status === "approved" && !row.revokedAt) {
    if (!(await verifySecret(row, input.deviceSecret))) {
      throw deviceNotTrusted(
        "This device's saved identity doesn't match what the server approved. Remove it in Settings → Devices from another device, then sign in again.",
      );
    }
    await db
      .update(trustedDevices)
      .set({ lastSeenAt: new Date(), deviceName: input.deviceName })
      .where(eq(trustedDevices.id, row.id));
    return row.id;
  }

  // First device on a server with no approved devices at all: the owner's,
  // straight after setup (or after an upgrade with nobody signed in).
  if (user.role === "owner") {
    const [{ n } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(trustedDevices)
      .where(and(eq(trustedDevices.status, "approved"), isNull(trustedDevices.revokedAt)));
    if (n === 0) return (await upsertDevice(db, user.id, identity, approved("bootstrap"))).id;
  }

  const methods = await getMethods(db);

  // Same device asking again while its request is open: same code.
  if (
    row &&
    row.status === "pending" &&
    row.expiresAt &&
    row.expiresAt > new Date() &&
    (await verifySecret(row, input.deviceSecret))
  ) {
    challenge(row, methods);
  }

  const [{ open } = { open: 0 }] = await db
    .select({ open: sql<number>`count(*)::int` })
    .from(trustedDevices)
    .where(
      and(
        eq(trustedDevices.userId, user.id),
        eq(trustedDevices.status, "pending"),
        gt(trustedDevices.expiresAt, new Date()),
      ),
    );
  if (open >= MAX_PENDING_PER_USER) throw rateLimited();

  const pending = await upsertDevice(db, user.id, identity, {
    approvalCode: await freshCode(db),
    expiresAt: new Date(Date.now() + PENDING_TTL_MS),
  });
  challenge(pending, methods);
}

/**
 * Sessions from before device approval existed have no device. When one
 * refreshes with an identity, adopt that device as approved, so signed-in
 * people aren't locked out by the upgrade.
 */
export async function adoptLegacySession(
  db: Db,
  session: { id: string; userId: string; deviceName: string; platform: Platform; trustedDeviceId: string | null },
  identity: { deviceId?: string | undefined; deviceSecret?: string | undefined },
): Promise<void> {
  if (session.trustedDeviceId || !identity.deviceId || !identity.deviceSecret) return;
  const existing = await db.query.trustedDevices.findFirst({
    where: and(eq(trustedDevices.userId, session.userId), eq(trustedDevices.deviceId, identity.deviceId)),
  });
  let id: string;
  if (existing && existing.status === "approved" && !existing.revokedAt) {
    if (!(await verifySecret(existing, identity.deviceSecret))) return;
    id = existing.id;
  } else {
    id = (
      await upsertDevice(
        db,
        session.userId,
        {
          deviceId: identity.deviceId,
          deviceSecret: identity.deviceSecret,
          deviceName: session.deviceName,
          platform: session.platform,
          ipAddress: null,
        },
        approved("existing-session"),
      )
    ).id;
  }
  await db.update(deviceSessions).set({ trustedDeviceId: id }).where(eq(deviceSessions.id, session.id));
}

/** The waiting device checks in. Approved → it may collect exactly one session. */
export async function pollApproval(
  db: Db,
  input: { approvalId: string; deviceId: string; deviceSecret: string },
): Promise<
  | { status: "pending"; expiresAt: string }
  | { status: "approved"; userId: string; trustedDeviceId: string; deviceName: string; platform: Platform }
  | { status: "denied" }
  | { status: "expired" }
> {
  const row = await db.query.trustedDevices.findFirst({ where: eq(trustedDevices.id, input.approvalId) });
  if (!row || row.deviceId !== input.deviceId || !(await verifySecret(row, input.deviceSecret))) {
    throw notFound("Approval request");
  }
  const now = new Date();
  if (row.status === "denied") return { status: "denied" };
  if (row.revokedAt || !row.expiresAt || row.expiresAt <= now) return { status: "expired" };
  if (row.status === "pending") return { status: "pending", expiresAt: row.expiresAt.toISOString() };
  // Approved: hand out the session once (the flag flips atomically).
  const [taken] = await db
    .update(trustedDevices)
    .set({ loginReady: false, lastSeenAt: now })
    .where(and(eq(trustedDevices.id, row.id), eq(trustedDevices.loginReady, true)))
    .returning({ id: trustedDevices.id });
  if (!taken) return { status: "expired" }; // already collected — sign in normally
  return { status: "approved", userId: row.userId, trustedDeviceId: row.id, deviceName: row.deviceName, platform: row.platform };
}

async function openRequest(db: Db, id: string): Promise<Row> {
  const row = await db.query.trustedDevices.findFirst({ where: eq(trustedDevices.id, id) });
  if (!row || row.status !== "pending" || !row.expiresAt || row.expiresAt <= new Date()) {
    throw notFound("Approval request");
  }
  return row;
}

function codesMatch(a: string, b: string): boolean {
  const x = Buffer.from(a.padEnd(6));
  const y = Buffer.from(b.padEnd(6));
  return x.length === y.length && timingSafeEqual(x, y);
}

async function markApproved(db: Db, row: Row, via: ApprovedVia, by: string | null): Promise<void> {
  const [done] = await db
    .update(trustedDevices)
    .set({
      ...approved(via, by),
      approvalCode: null,
      loginReady: true,
      // Window for the waiting device to collect its session.
      expiresAt: new Date(Date.now() + PENDING_TTL_MS),
    })
    // Only while still pending: a request denied meanwhile (say, by a password
    // change) must not be revived by an approval that read it just before.
    .where(and(eq(trustedDevices.id, row.id), eq(trustedDevices.status, "pending")))
    .returning({ id: trustedDevices.id });
  if (!done) throw notFound("Approval request");
}

export interface Approver {
  userId: string;
  role: UserRole;
}

const canActOn = (approver: Approver, row: Row) => approver.role === "owner" || row.userId === approver.userId;

/** Number matching from a trusted device: the approver types the code the new device shows. */
export async function approveFromDevice(db: Db, approver: Approver, id: string, code: string): Promise<void> {
  const methods = await getMethods(db);
  if (!methods.trustedDevice) {
    throw forbidden("Approving from another device is turned off on this server. Approve it on the server console instead.");
  }
  const row = await openRequest(db, id);
  if (!canActOn(approver, row)) throw notFound("Approval request");
  if (!row.approvalCode || !codesMatch(row.approvalCode, code.trim())) {
    const attempts = row.codeAttempts + 1;
    await db
      .update(trustedDevices)
      .set(attempts >= MAX_CODE_ATTEMPTS ? { codeAttempts: attempts, status: "denied" } : { codeAttempts: attempts })
      .where(and(eq(trustedDevices.id, row.id), eq(trustedDevices.status, "pending")));
    throw new AppError(
      "VALIDATION_ERROR",
      400,
      attempts >= MAX_CODE_ATTEMPTS
        ? "Too many wrong codes — this request was denied. The other device can sign in again to get a new code."
        : "That code doesn't match the one on the new device.",
      { code: "Doesn't match" },
    );
  }
  await markApproved(db, row, "device", approver.userId);
}

export async function deny(db: Db, approver: Approver, id: string): Promise<void> {
  const row = await openRequest(db, id);
  if (!canActOn(approver, row)) throw notFound("Approval request");
  await db.update(trustedDevices).set({ status: "denied", approvalCode: null }).where(eq(trustedDevices.id, row.id));
}

/** Server console (`vault approve <code>`). `override` is the recovery path when console approval is turned off. */
export async function approveFromConsole(
  db: Db,
  code: string,
  opts: { override?: boolean } = {},
): Promise<{ deviceName: string; userDisplayName: string }> {
  const methods = await getMethods(db);
  if (!methods.serverConsole && !opts.override) {
    throw forbidden(
      "Approving on the server console is turned off. Approve from a trusted device, or re-run with --override if you're locked out.",
    );
  }
  const clean = code.replace(/\D/g, "");
  const row = await db.query.trustedDevices.findFirst({
    where: and(
      eq(trustedDevices.approvalCode, clean),
      eq(trustedDevices.status, "pending"),
      gt(trustedDevices.expiresAt, new Date()),
    ),
  });
  if (!row) throw notFound(`Open request with code ${clean}`);
  await markApproved(db, row, "console", null);
  const user = await db.query.users.findFirst({ where: eq(users.id, row.userId) });
  return { deviceName: row.deviceName, userDisplayName: user?.displayName ?? "?" };
}

export async function denyFromConsole(db: Db, code: string): Promise<void> {
  const clean = code.replace(/\D/g, "");
  const [row] = await db
    .update(trustedDevices)
    .set({ status: "denied", approvalCode: null })
    .where(
      and(
        eq(trustedDevices.approvalCode, clean),
        eq(trustedDevices.status, "pending"),
        gt(trustedDevices.expiresAt, new Date()),
      ),
    )
    .returning({ id: trustedDevices.id });
  if (!row) throw notFound(`Open request with code ${clean}`);
}

export async function listPending(db: Db, viewer: Approver | null): Promise<Array<PendingApproval & { code?: string }>> {
  const rows = await db
    .select({ d: trustedDevices, name: users.displayName })
    .from(trustedDevices)
    .innerJoin(users, eq(users.id, trustedDevices.userId))
    .where(and(eq(trustedDevices.status, "pending"), gt(trustedDevices.expiresAt, new Date())));
  return rows
    .filter(({ d }) => viewer === null || canActOn(viewer, d))
    .map(({ d, name }) => ({
      id: d.id,
      userId: d.userId,
      userDisplayName: name,
      deviceName: d.deviceName,
      platform: d.platform,
      ipAddress: d.requestIp,
      requestedAt: d.requestedAt.toISOString(),
      expiresAt: d.expiresAt!.toISOString(),
      // Only the console (viewer === null) sees codes; approvers must type them.
      ...(viewer === null && d.approvalCode ? { code: d.approvalCode } : {}),
    }));
}

export async function listTrusted(
  db: Db,
  viewer: Approver | null,
  currentTrustedId: string | null,
): Promise<TrustedDevice[]> {
  const rows = await db
    .select({ d: trustedDevices, name: users.displayName })
    .from(trustedDevices)
    .innerJoin(users, eq(users.id, trustedDevices.userId))
    .where(and(eq(trustedDevices.status, "approved"), isNull(trustedDevices.revokedAt)));
  return rows
    .filter(({ d }) => viewer === null || canActOn(viewer, d))
    .map(({ d, name }) => ({
      id: d.id,
      userId: d.userId,
      userDisplayName: name,
      deviceName: d.deviceName,
      platform: d.platform,
      approvedAt: d.approvedAt?.toISOString() ?? null,
      approvedVia: d.approvedVia,
      lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
      current: d.id === currentTrustedId,
    }));
}

/** Remove a device's approval, sign it out everywhere, and delete its biometric keys. */
export async function revokeDevice(db: Db, viewer: Approver | null, id: string): Promise<void> {
  const row = await db.query.trustedDevices.findFirst({ where: eq(trustedDevices.id, id) });
  if (!row || row.revokedAt || row.status !== "approved" || (viewer && !canActOn(viewer, row))) {
    throw notFound("Device");
  }
  const now = new Date();
  await db.update(trustedDevices).set({ revokedAt: now, loginReady: false }).where(eq(trustedDevices.id, id));
  await db
    .update(deviceSessions)
    .set({ revokedAt: now })
    .where(and(eq(deviceSessions.trustedDeviceId, id), isNull(deviceSessions.revokedAt)));
  await db.delete(deviceKeys).where(eq(deviceKeys.trustedDeviceId, id));
}
