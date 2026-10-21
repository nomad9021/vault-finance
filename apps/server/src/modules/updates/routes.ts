import type { UpdateStatusResponse } from "@vault/shared";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import { updateUnavailable } from "../../errors.js";
import { writeUpdateRequest } from "./agent.js";
import { getUpdateStatus, refreshUpdateStatus } from "./service.js";

export default async function updateRoutes(
  app: FastifyInstance,
  opts: { config: AppConfig },
) {
  // Any authenticated member can see whether the server is behind — the desktop
  // app renders a small banner from this. Acting on it is an owner task.
  app.get(
    "/updates/status",
    { preHandler: [app.requireAuth] },
    async (): Promise<UpdateStatusResponse> =>
      getUpdateStatus(app.db, opts.config, app.log),
  );

  // "Check now" — skips the wait for the daily check after a release.
  app.post(
    "/updates/check",
    { preHandler: [app.requireOwner] },
    async (): Promise<UpdateStatusResponse> =>
      refreshUpdateStatus(app.db, opts.config, app.log),
  );

  // Start an update from the app. The server can't update itself (it has no
  // Docker access, on purpose); it asks the host's update agent to run the
  // same vault-update an operator would. Always updates to the latest release.
  app.post(
    "/updates/apply",
    { preHandler: [app.requireOwner] },
    async (request): Promise<UpdateStatusResponse> => {
      const dir = opts.config.updates.agentDir;
      if (opts.config.updates.operatorManaged) {
        throw updateUnavailable("This server is managed by an administrator, who rolls out updates.");
      }
      const status = await refreshUpdateStatus(app.db, opts.config, app.log);
      if (!dir || !status.selfUpdate) {
        throw updateUnavailable(
          "In-app updates aren't set up on this server. On the server, run installers/server/enable-app-updates.sh once.",
        );
      }
      if (status.selfUpdate.state === "requested" || status.selfUpdate.state === "running") {
        throw updateUnavailable("An update is already in progress.");
      }
      if (!status.updateAvailable || !status.latestVersion) {
        throw updateUnavailable(`The server is already on the latest version (${status.currentVersion}).`);
      }

      writeUpdateRequest(dir, {
        targetVersion: status.latestVersion,
        fromVersion: status.currentVersion,
        requestedBy: request.auth!.userId,
      });
      app.log.info(
        { userId: request.auth!.userId, from: status.currentVersion, to: status.latestVersion },
        "server update requested from the app",
      );
      return getUpdateStatus(app.db, opts.config, app.log);
    },
  );
}
