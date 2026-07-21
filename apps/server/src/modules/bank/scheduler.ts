import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import { syncAllConnections } from "./service.js";

/**
 * Periodically re-sync bank connections so transactions appear without the user
 * clicking "Sync" — the "live/auto-updating" path that works for a self-hosted
 * server that isn't reachable from the internet (unlike Plaid webhooks, which
 * need a public endpoint). Disabled when BANK_AUTO_SYNC_MINUTES is 0.
 */
export function startBankAutoSync(app: FastifyInstance, config: AppConfig): void {
  const minutes = config.bankAutoSyncMinutes;
  if (minutes <= 0) return;

  const tick = () => {
    void syncAllConnections(app, config)
      .then((r) => {
        if (r.imported > 0) {
          app.log.info({ ...r }, "bank auto-sync imported new transactions");
        }
      })
      .catch((err) => app.log.error({ err }, "bank auto-sync tick failed"));
  };

  const timer = setInterval(tick, minutes * 60_000);
  timer.unref(); // never keep the process alive just for the scheduler
  app.addHook("onClose", async () => clearInterval(timer));
  app.log.info({ minutes }, "bank auto-sync scheduler started");
}
