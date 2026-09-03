import {
  AcceptInviteRequest,
  CreateMemberRequest,
  InviteMemberRequest,
  type InvitePreviewResponse,
  type Member,
  type MemberListResponse,
} from "@vault/shared";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import { notFound } from "../../errors.js";
import { memberAdded, memberInvite } from "../../lib/email-templates.js";
import * as members from "./service.js";

export default async function memberRoutes(
  app: FastifyInstance,
  opts: { config: AppConfig },
) {
  const publicUrl = opts.config.mail.appPublicUrl;
  const inviteUrl = (token: string) =>
    publicUrl ? `${publicUrl}/invite?token=${encodeURIComponent(token)}` : null;

  app.get(
    "/members",
    { preHandler: [app.requireOwner] },
    async (): Promise<MemberListResponse> => members.listMembers(app.db),
  );

  app.post("/members/invite", { preHandler: [app.requireOwner] }, async (request, reply) => {
    const body = InviteMemberRequest.parse(request.body);
    const inviter = await app.db.query.users.findFirst({
      where: (t, { eq }) => eq(t.id, request.auth!.userId),
    });
    const { token, expiresAt } = await members.createInvite(app.db, {
      displayName: body.displayName,
      email: body.email,
      invitedByUserId: request.auth!.userId,
    });

    const url = inviteUrl(token);
    if (url) {
      await app.mailer.send({
        to: body.email.trim().toLowerCase(),
        ...memberInvite({
          inviterName: inviter?.displayName ?? "A household owner",
          inviteUrl: url,
          expiresAt,
        }),
      });
    } else {
      app.log.warn(
        "member invited but APP_PUBLIC_URL is unset — no email sent. Invite link: /invite?token=" +
          token,
      );
    }
    // The raw link is returned so the owner can share it manually (e.g. when
    // SMTP isn't set up). It's shown once and not stored anywhere retrievable.
    return reply.status(201).send({ inviteUrl: url ?? `/invite?token=${token}` });
  });

  app.post("/members", { preHandler: [app.requireOwner] }, async (request, reply) => {
    const body = CreateMemberRequest.parse(request.body);
    const inviter = await app.db.query.users.findFirst({
      where: (t, { eq }) => eq(t.id, request.auth!.userId),
    });
    const member: Member = await members.createMember(app.db, body);
    await app.mailer.send({
      to: member.email,
      ...memberAdded({
        displayName: member.displayName,
        inviterName: inviter?.displayName ?? "A household owner",
        connectUrl: publicUrl ?? undefined,
      }),
    });
    return reply.status(201).send(member);
  });

  app.delete<{ Params: { id: string } }>(
    "/members/:id",
    { preHandler: [app.requireOwner] },
    async (request, reply) => {
      await members.removeMemberOrInvite(app.db, request.params.id, request.auth!.userId);
      return reply.status(204).send();
    },
  );

  // ── Public invite-accept flow (no auth; the token is the credential) ──
  app.get<{ Params: { token: string } }>(
    "/members/invite/:token",
    async (request): Promise<InvitePreviewResponse> => {
      if (!request.params.token) throw notFound("Invite");
      return members.previewInvite(app.db, request.params.token);
    },
  );

  app.post<{ Params: { token: string } }>(
    "/members/invite/:token/accept",
    async (request, reply) => {
      const body = AcceptInviteRequest.parse(request.body);
      await members.acceptInvite(app.db, request.params.token, body.password);
      return reply.status(204).send();
    },
  );
}
