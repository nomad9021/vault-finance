import {
  AcceptInviteRequest,
  ConnectEmailRequest,
  CreateMemberRequest,
  type EmailConnectionStatus,
  InviteMemberRequest,
  type InviteMemberResponse,
  mailServerFor,
  type InvitePreviewResponse,
  type Member,
  type MemberListResponse,
} from "@vault/shared";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import { ownerEmail } from "../../db/schema.js";
import { AppError, notFound } from "../../errors.js";
import { memberAdded, memberInvite } from "../../lib/email-templates.js";
import type { MailMessage } from "../../lib/mailer.js";
import { loadOwnerMailbox, mailProblem, sendAsOwner, verifyMailbox } from "../../lib/owner-email.js";
import { encryptSecret } from "../../secret-crypto.js";
import * as members from "./service.js";

/** An http(s) origin other people could open, or null for loopback addresses. */
function shareableOrigin(serverUrl: string | undefined): string | null {
  if (!serverUrl) return null;
  try {
    const u = new URL(serverUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const host = u.hostname;
    if (host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || host.startsWith("127.")) {
      return null;
    }
    return u.origin;
  } catch {
    return null;
  }
}

export default async function memberRoutes(
  app: FastifyInstance,
  opts: { config: AppConfig },
) {
  const publicUrl = opts.config.mail.appPublicUrl;
  /** APP_PUBLIC_URL wins; else the address the owner's app reached us on. */
  const inviteUrl = (token: string, serverUrl: string | undefined) => {
    const base = publicUrl ?? shareableOrigin(serverUrl);
    return base ? `${base}/invite?token=${encodeURIComponent(token)}` : null;
  };

  const emailStatus = async (): Promise<EmailConnectionStatus> => {
    const row = await app.db.query.ownerEmail.findFirst();
    return {
      connected: Boolean(row),
      fromEmail: row?.fromEmail ?? null,
      serverMailAvailable: app.mailer.enabled,
    };
  };

  /** Send from the owner's mailbox when connected, else the server's relay. Throws on failure. */
  const deliver = async (msg: MailMessage, fromName: string): Promise<string | null> => {
    const box = await loadOwnerMailbox(app.db);
    if (box) {
      await sendAsOwner(box, fromName, msg);
      return box.fromEmail;
    }
    await app.mailer.sendOrThrow(msg);
    return null;
  };

  app.get(
    "/members/email",
    { preHandler: [app.requireOwner] },
    async (): Promise<EmailConnectionStatus> => emailStatus(),
  );

  app.post(
    "/members/email",
    { preHandler: [app.requireOwner] },
    async (request): Promise<EmailConnectionStatus> => {
      const body = ConnectEmailRequest.parse(request.body);
      const fromEmail = body.email.trim().toLowerCase();
      const server = body.host
        ? { host: body.host, port: body.port ?? 587 }
        : mailServerFor(fromEmail);
      if (!server) {
        throw new AppError("VALIDATION_ERROR", 400, "Enter your email provider's mail server.", {
          host: "Required for this email address",
        });
      }
      // Google displays app passwords in groups separated by spaces.
      const password = server.host === "smtp.gmail.com" ? body.password.replace(/\s+/g, "") : body.password;
      try {
        await verifyMailbox({ fromEmail, ...server, password });
      } catch (err) {
        throw new AppError("VALIDATION_ERROR", 400, mailProblem(err));
      }
      const values = {
        id: true as const,
        fromEmail,
        ...server,
        password: encryptSecret(password),
        updatedAt: new Date(),
      };
      await app.db
        .insert(ownerEmail)
        .values(values)
        .onConflictDoUpdate({ target: ownerEmail.id, set: values });
      return emailStatus();
    },
  );

  app.post(
    "/members/email/disconnect",
    { preHandler: [app.requireOwner] },
    async (): Promise<EmailConnectionStatus> => {
      await app.db.delete(ownerEmail);
      return emailStatus();
    },
  );

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

    const inviterName = inviter?.displayName ?? "A household owner";
    const url = inviteUrl(token, body.serverUrl);
    const canEmail = app.mailer.enabled || (await emailStatus()).connected;
    let emailed = false;
    let sentFrom: string | null = null;
    let emailProblem: string | null = null;
    if (body.sendEmail === false) {
      // The owner will pass the link on themselves; nothing to send or report.
    } else if (!url) {
      // Never log the link itself: the token is a credential, and the owner
      // already gets it in the response below.
      app.log.warn("member invited but no shareable server address is known — no email sent");
      emailProblem =
        "This app is connected to the server through a local address that other people can't open, so no email was sent. Set APP_PUBLIC_URL on the server, or connect the app using the server's network address.";
    } else if (!canEmail) {
      emailProblem = "No email account is connected, so no email was sent.";
    } else {
      try {
        sentFrom = await deliver(
          {
            to: body.email.trim().toLowerCase(),
            ...memberInvite({ inviterName, inviteUrl: url, expiresAt }),
          },
          inviterName,
        );
        emailed = true;
      } catch (err) {
        app.log.error({ code: (err as { code?: unknown } | null)?.code }, "invitation email failed");
        emailProblem = mailProblem(err);
      }
    }
    // The raw link is returned so the owner can share it manually when email
    // couldn't go out. It's shown once and not stored anywhere retrievable.
    const response: InviteMemberResponse = {
      inviteUrl: url ?? `/invite?token=${token}`,
      emailed,
      sentFrom,
      emailProblem,
    };
    return reply.status(201).send(response);
  });

  app.post("/members", { preHandler: [app.requireOwner] }, async (request, reply) => {
    const body = CreateMemberRequest.parse(request.body);
    const inviter = await app.db.query.users.findFirst({
      where: (t, { eq }) => eq(t.id, request.auth!.userId),
    });
    const member: Member = await members.createMember(app.db, body);
    const inviterName = inviter?.displayName ?? "A household owner";
    // Best effort: the account exists either way, and the owner hands over the password.
    await deliver(
      {
        to: member.email,
        ...memberAdded({
          displayName: member.displayName,
          inviterName,
          connectUrl: publicUrl ?? undefined,
        }),
      },
      inviterName,
    ).catch((err: unknown) => {
      app.log.warn({ code: (err as { code?: unknown } | null)?.code }, "member-added email not sent");
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
      await members.acceptInvite(app.db, request.params.token, body.password, body.displayName);
      return reply.status(204).send();
    },
  );
}
