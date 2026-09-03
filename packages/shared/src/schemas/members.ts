import { z } from "zod";
import { UserRole } from "./common.js";

export const Member = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
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
  displayName: z.string().min(1).max(100),
  email: z.string().email(),
});
export type InviteMemberRequest = z.infer<typeof InviteMemberRequest>;

export const CreateMemberRequest = z.object({
  displayName: z.string().min(1).max(100),
  email: z.string().email(),
  tempPassword: z.string().min(10).max(200),
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
  password: z.string().min(10).max(200),
});
export type AcceptInviteRequest = z.infer<typeof AcceptInviteRequest>;
