import { compareSemver, type ApiError } from "@vault/shared";
import fp from "fastify-plugin";

/**
 * Version-compatibility gate (see docs/api-design.md). Clients send
 * X-Client-Version on every request; a version below minClientVersion gets a
 * 426 with a human-readable message the client renders as a blocking
 * "update required" screen. Requests without the header (curl, scripts) pass —
 * the gate protects known clients from silent breakage, it is not access
 * control.
 */
export default fp(
  async (app, opts: { minClientVersion: string }) => {
    app.addHook("onRequest", async (request, reply) => {
      const clientVersion = request.headers["x-client-version"];
      if (typeof clientVersion !== "string" || clientVersion.length === 0) return;
      if (!/^\d+\.\d+\.\d+$/.test(clientVersion)) return;

      if (compareSemver(clientVersion, opts.minClientVersion) < 0) {
        const body: ApiError = {
          error: {
            code: "CLIENT_VERSION_TOO_OLD",
            message: `This app version (${clientVersion}) is older than the server requires (${opts.minClientVersion}). Please update the app.`,
          },
        };
        return reply.status(426).send(body);
      }
    });
  },
  { name: "version-gate" },
);
