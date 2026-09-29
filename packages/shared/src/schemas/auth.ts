import { z } from "zod";
import { Platform } from "./common.js";
import { User } from "./user.js";

export const LoginRequest = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  deviceName: z.string().min(1).max(100),
  platform: Platform,
  /** 6-digit TOTP code, required only when the account has 2FA enabled. */
  totpCode: z.string().optional(),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const TokenPair = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});
export type TokenPair = z.infer<typeof TokenPair>;

export const LoginResponse = TokenPair.extend({
  user: User,
});
export type LoginResponse = z.infer<typeof LoginResponse>;

export const RefreshRequest = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshRequest = z.infer<typeof RefreshRequest>;

export const LogoutRequest = z.object({
  refreshToken: z.string().min(1),
});
export type LogoutRequest = z.infer<typeof LogoutRequest>;

export const DeviceSession = z.object({
  id: z.string().uuid(),
  deviceName: z.string(),
  platform: Platform,
  ipAddress: z.string().nullable(),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime(),
  isCurrent: z.boolean(),
});
export type DeviceSession = z.infer<typeof DeviceSession>;

export const SessionListResponse = z.object({
  sessions: z.array(DeviceSession),
});
export type SessionListResponse = z.infer<typeof SessionListResponse>;

/**
 * Public login-screen profile (unauthenticated). Deliberately excludes email;
 * display name + avatar color are what the design's profile picker renders.
 */
export const PublicProfile = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  avatarColor: z.string(),
});
export type PublicProfile = z.infer<typeof PublicProfile>;

export const ProfilesResponse = z.object({
  profiles: z.array(PublicProfile),
  /** The household's own name ("The Carters"); null until the owner sets one. */
  householdName: z.string().nullable().optional(),
});
export type ProfilesResponse = z.infer<typeof ProfilesResponse>;

export const LoginByIdRequest = z.object({
  userId: z.string().uuid(),
  password: z.string().min(1),
  deviceName: z.string().min(1).max(100),
  platform: Platform,
  /** 6-digit TOTP code, required only when the account has 2FA enabled. */
  totpCode: z.string().optional(),
});
export type LoginByIdRequest = z.infer<typeof LoginByIdRequest>;

// ── Two-factor authentication (TOTP) ──

export const TotpStatusResponse = z.object({
  enabled: z.boolean(),
});
export type TotpStatusResponse = z.infer<typeof TotpStatusResponse>;

/** Returned by setup: the base32 secret + an otpauth:// URI for the app/QR. */
export const TotpSetupResponse = z.object({
  secret: z.string(),
  otpauthUri: z.string(),
});
export type TotpSetupResponse = z.infer<typeof TotpSetupResponse>;

export const TotpEnableRequest = z.object({
  code: z.string().min(6).max(10),
});
export type TotpEnableRequest = z.infer<typeof TotpEnableRequest>;

export const TotpDisableRequest = z.object({
  /** Re-auth: confirm the account password to turn 2FA off. */
  password: z.string().min(1),
});
export type TotpDisableRequest = z.infer<typeof TotpDisableRequest>;

/** Claims carried in the access JWT. */
export const AccessTokenClaims = z.object({
  sub: z.string().uuid(), // userId
  sid: z.string().uuid(), // deviceSessionId
  role: z.enum(["owner", "member"]),
});
export type AccessTokenClaims = z.infer<typeof AccessTokenClaims>;

// ── Device keys (biometric sign-in) ──
// A per-device sign-in credential the desktop app keeps in the OS keychain and
// only releases after a local Windows Hello / Touch ID / fingerprint check.
// The server never sees anything biometric — just this revocable key.

export const CreateDeviceKeyRequest = z.object({
  deviceName: z.string().min(1).max(100),
  platform: Platform,
});
export type CreateDeviceKeyRequest = z.infer<typeof CreateDeviceKeyRequest>;

/** `key` is `<id>.<secret>` and is shown exactly once. */
export const CreateDeviceKeyResponse = z.object({
  id: z.string().uuid(),
  key: z.string(),
});
export type CreateDeviceKeyResponse = z.infer<typeof CreateDeviceKeyResponse>;

export const DeviceKey = z.object({
  id: z.string().uuid(),
  deviceName: z.string(),
  platform: Platform,
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
});
export type DeviceKey = z.infer<typeof DeviceKey>;

export const DeviceKeyListResponse = z.object({
  keys: z.array(DeviceKey),
});
export type DeviceKeyListResponse = z.infer<typeof DeviceKeyListResponse>;

export const DeviceKeyLoginRequest = z.object({
  key: z.string().min(1).max(200),
  deviceName: z.string().min(1).max(100),
  platform: Platform,
});
export type DeviceKeyLoginRequest = z.infer<typeof DeviceKeyLoginRequest>;
