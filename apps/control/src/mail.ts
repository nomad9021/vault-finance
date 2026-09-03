import nodemailer from "nodemailer";

/**
 * The control plane sends exactly one kind of email: a welcome to a new
 * family's owner. Everything else is the family server's job. Best-effort —
 * a create never fails because email didn't send.
 */
export interface WelcomeInput {
  ownerEmail: string;
  connectUrl: string;
  surveyUrl?: string | undefined;
}

const smtp = {
  host: process.env["SMTP_HOST"],
  port: Number(process.env["SMTP_PORT"] ?? 587),
  user: process.env["SMTP_USER"],
  pass: process.env["SMTP_PASS"],
  secure: process.env["SMTP_SECURE"] === "true",
  from: process.env["MAIL_FROM"] ?? "Vault Finance <no-reply@vault.local>",
};

export const mailEnabled = Boolean(smtp.host);

export async function sendWelcome(input: WelcomeInput): Promise<boolean> {
  if (!smtp.host) return false;
  const survey = input.surveyUrl
    ? `\n\nWhen you've had a chance to try it, we'd love your feedback — it takes about two minutes:\n${input.surveyUrl}`
    : "";
  const text =
    `Your Vault Finance server is ready. 🎉\n\n` +
    `Open the desktop app, choose "Connect to a server", and enter:\n${input.connectUrl}\n\n` +
    `You'll confirm the server's certificate once, then create your owner account. ` +
    `Nothing you do is visible to any other family.${survey}\n`;
  try {
    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      ...(smtp.user && smtp.pass ? { auth: { user: smtp.user, pass: smtp.pass } } : {}),
    });
    await transport.sendMail({
      from: smtp.from,
      to: input.ownerEmail,
      subject: "Your Vault Finance server is ready",
      text,
    });
    return true;
  } catch {
    return false;
  }
}
