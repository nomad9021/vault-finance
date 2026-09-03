import nodemailer, { type Transporter } from "nodemailer";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface Mailer {
  /** True when an SMTP relay is configured. Callers can skip building a message when false. */
  readonly enabled: boolean;
  /**
   * Best-effort send. Never throws: a missing relay logs a warning once and
   * drops the message; a transport failure is logged at error level. Email is
   * a notification, never part of a request's success path.
   */
  send(msg: MailMessage): Promise<void>;
}

/** No-op mailer used when SMTP_HOST is unset (and in tests). */
class NullMailer implements Mailer {
  readonly enabled = false;
  private warned = false;
  constructor(private readonly log: FastifyBaseLogger) {}
  async send(msg: MailMessage): Promise<void> {
    if (!this.warned) {
      this.log.warn(
        "SMTP is not configured (SMTP_HOST unset) — outbound email is disabled",
      );
      this.warned = true;
    }
    this.log.info({ to: msg.to, subject: msg.subject }, "email dropped (no SMTP relay)");
  }
}

class SmtpMailer implements Mailer {
  readonly enabled = true;
  private readonly transport: Transporter;
  constructor(
    private readonly cfg: AppConfig["mail"],
    private readonly log: FastifyBaseLogger,
  ) {
    this.transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      ...(cfg.user && cfg.pass ? { auth: { user: cfg.user, pass: cfg.pass } } : {}),
    });
  }
  async send(msg: MailMessage): Promise<void> {
    try {
      await this.transport.sendMail({
        from: this.cfg.from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      });
      this.log.info({ to: msg.to, subject: msg.subject }, "email sent");
    } catch (err) {
      this.log.error({ err, to: msg.to, subject: msg.subject }, "email send failed");
    }
  }
}

export function createMailer(config: AppConfig, log: FastifyBaseLogger): Mailer {
  return config.mail.host ? new SmtpMailer(config.mail, log) : new NullMailer(log);
}
