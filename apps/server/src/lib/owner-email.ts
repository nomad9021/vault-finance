import nodemailer, { type Transporter } from "nodemailer";
import type { Db } from "../plugins/db.js";
import { decryptSecret } from "../secret-crypto.js";
import type { MailMessage } from "./mailer.js";

/** A mailbox the owner connected, with its app password in plaintext. */
export interface OwnerMailbox {
  fromEmail: string;
  host: string;
  port: number;
  password: string;
}

function transportFor(box: OwnerMailbox): Transporter {
  const secure = box.port === 465;
  return nodemailer.createTransport({
    host: box.host,
    port: box.port,
    secure,
    // Same rule as lib/mailer.ts: the password never travels in plaintext.
    requireTLS: !secure,
    tls: { minVersion: "TLSv1.2" },
    auth: { user: box.fromEmail, pass: box.password },
    // Sending happens inside the owner's request, so fail in seconds.
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
}

/**
 * Plain-language reason a mail attempt failed. Raw transport errors can echo
 * server responses, so only this text is ever shown to the owner.
 */
export function mailProblem(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "EAUTH") {
    return "Your email provider rejected that sign-in. Check the address and use an app password, not your normal password.";
  }
  if (code === "EENVELOPE") {
    return "Your email provider refused that recipient address.";
  }
  if (code === "ESOCKET" || code === "ECONNECTION" || code === "ETIMEDOUT" || code === "EDNS") {
    return "Couldn't reach your email provider from the server. Check the mail server address and the server's internet connection.";
  }
  return "Your email provider didn't accept the message. Please try again.";
}

/** Sign in without sending anything. Throws what nodemailer throws. */
export async function verifyMailbox(box: OwnerMailbox): Promise<void> {
  await transportFor(box).verify();
}

/** Send from the owner's own address. Throws on failure: callers report it. */
export async function sendAsOwner(box: OwnerMailbox, fromName: string, msg: MailMessage): Promise<void> {
  await transportFor(box).sendMail({
    from: { name: fromName, address: box.fromEmail },
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
  });
}

export async function loadOwnerMailbox(db: Db): Promise<OwnerMailbox | null> {
  const row = await db.query.ownerEmail.findFirst();
  if (!row) return null;
  return {
    fromEmail: row.fromEmail,
    host: row.host,
    port: row.port,
    password: decryptSecret(row.password),
  };
}
