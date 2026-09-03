import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import { updateAvailable } from "../../lib/email-templates.js";
import {
  getNotifiedVersion,
  refreshUpdateStatus,
  setNotifiedVersion,
} from "./service.js";

/**
 * Once a day, check whether a newer release is published. The first time we see
 * a given new version, email the household owner with upgrade instructions.
 * Disabled by UPDATE_CHECK_ENABLED=false (tests, air-gapped servers).
 */
export function startUpdateChecks(app: FastifyInstance, config: AppConfig): void {
  if (!config.updates.enabled) return;

  const tick = async () => {
    try {
      const status = await refreshUpdateStatus(app.db, config, app.log);
      if (!status.updateAvailable || !status.latestVersion) return;

      const alreadyNotified = await getNotifiedVersion(app.db);
      if (alreadyNotified === status.latestVersion) return;

      const owner = await app.db.query.users.findFirst({
        where: (t, { eq }) => eq(t.role, "owner"),
        orderBy: (t, { asc }) => [asc(t.createdAt)],
      });
      if (owner) {
        await app.mailer.send({
          to: owner.email,
          ...updateAvailable({
            currentVersion: status.currentVersion,
            latestVersion: status.latestVersion,
            notesUrl: status.notesUrl ?? undefined,
            operatorManaged: config.updates.operatorManaged,
          }),
        });
      }
      await setNotifiedVersion(app.db, status.latestVersion);
      app.log.info(
        { latest: status.latestVersion, current: status.currentVersion },
        "update available — owner notified",
      );
    } catch (err) {
      app.log.error({ err }, "update check tick failed");
    }
  };

  // First run shortly after boot, then on the configured interval.
  const first = setTimeout(() => void tick(), 60_000);
  first.unref();
  const timer = setInterval(() => void tick(), config.updates.intervalHours * 60 * 60_000);
  timer.unref();
  app.addHook("onClose", async () => {
    clearTimeout(first);
    clearInterval(timer);
  });
  app.log.info({ intervalHours: config.updates.intervalHours }, "update-check scheduler started");
}
