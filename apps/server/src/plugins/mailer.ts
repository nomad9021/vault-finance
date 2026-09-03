import fp from "fastify-plugin";
import type { AppConfig } from "../config.js";
import { createMailer, type Mailer } from "../lib/mailer.js";

declare module "fastify" {
  interface FastifyInstance {
    mailer: Mailer;
  }
}

/**
 * Decorates `app.mailer` so any module can send a notification email without
 * threading transport config through. Sends are best-effort (see lib/mailer.ts).
 */
export default fp(
  async (app, opts: { config: AppConfig }) => {
    app.decorate("mailer", createMailer(opts.config, app.log));
  },
  { name: "mailer" },
);
