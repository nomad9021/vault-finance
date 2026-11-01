import { z } from "zod";
import { NewPassword } from "./password.js";
import { UserRole } from "./common.js";

export const Member = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  avatarColor: z.string().optional(),
  avatarImage: z.string().nullable().optional(),
  email: z.string(),
  role: UserRole,
  createdAt: z.string().datetime(),
});
export type Member = z.infer<typeof Member>;

export const PendingInvite = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  email: z.string(),
  invitedByName: z.string().nullable(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
export type PendingInvite = z.infer<typeof PendingInvite>;

export const MemberListResponse = z.object({
  members: z.array(Member),
  invites: z.array(PendingInvite),
});
export type MemberListResponse = z.infer<typeof MemberListResponse>;

export const InviteMemberRequest = z.object({
  /** Optional: the invited person can set their own name when they accept. */
  displayName: z.string().trim().min(1).max(100).optional(),
  email: z.string().email(),
  /** The address the owner's app uses; builds the link when APP_PUBLIC_URL is unset. */
  serverUrl: z.string().url().max(500).optional(),
});
export type InviteMemberRequest = z.infer<typeof InviteMemberRequest>;

export const InviteMemberResponse = z.object({
  inviteUrl: z.string(),
  /** True only once a mail server accepted the message. */
  emailed: z.boolean().default(false),
  sentFrom: z.string().nullable().default(null),
  /** Why it wasn't emailed, in words to show the owner. */
  emailProblem: z.string().nullable().default(null),
});
// Input type: fields stay optional so a newer app can talk to an older server.
export type InviteMemberResponse = z.input<typeof InviteMemberResponse>;

/** The owner's connected mailbox. The password is never returned. */
export const EmailConnectionStatus = z.object({
  connected: z.boolean(),
  fromEmail: z.string().nullable(),
  /** A server-wide SMTP relay exists, so invites can send without connecting. */
  serverMailAvailable: z.boolean(),
});
export type EmailConnectionStatus = z.infer<typeof EmailConnectionStatus>;

export const ConnectEmailRequest = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(500),
  /** Only needed for providers without a known mail server. */
  host: z.string().trim().min(1).max(253).optional(),
  port: z.number().int().min(1).max(65535).optional(),
});
export type ConnectEmailRequest = z.infer<typeof ConnectEmailRequest>;

const MAIL_SERVERS: Record<string, { host: string; port: number }> = {
  "gmail.com": { host: "smtp.gmail.com", port: 465 },
  "googlemail.com": { host: "smtp.gmail.com", port: 465 },
  "yahoo.com": { host: "smtp.mail.yahoo.com", port: 465 },
  "aol.com": { host: "smtp.aol.com", port: 465 },
  "icloud.com": { host: "smtp.mail.me.com", port: 587 },
  "me.com": { host: "smtp.mail.me.com", port: 587 },
  "mac.com": { host: "smtp.mail.me.com", port: 587 },
  "fastmail.com": { host: "smtp.fastmail.com", port: 465 },
};

/** The mail server for well-known providers, so most owners never see one. */
export function mailServerFor(email: string): { host: string; port: number } | null {
  const domain = email.trim().toLowerCase().split("@")[1];
  return (domain && MAIL_SERVERS[domain]) || null;
}

export const CreateMemberRequest = z.object({
  displayName: z.string().min(1).max(100),
  email: z.string().email(),
  tempPassword: NewPassword,
});
export type CreateMemberRequest = z.infer<typeof CreateMemberRequest>;

/** Public: what the invite-accept page shows before the person sets a password. */
export const InvitePreviewResponse = z.object({
  displayName: z.string(),
  email: z.string(),
  invitedByName: z.string().nullable(),
});
export type InvitePreviewResponse = z.infer<typeof InvitePreviewResponse>;

export const AcceptInviteRequest = z.object({
  password: NewPassword,
  displayName: z.string().trim().min(1).max(100).optional(),
});
export type AcceptInviteRequest = z.infer<typeof AcceptInviteRequest>;
