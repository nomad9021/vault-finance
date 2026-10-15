import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApp, type BuildAppOptions } from "../../src/app.js";
import { approveFromConsole } from "../../src/modules/devices/service.js";

/** One fixed device identity for every sign-in in tests that aren't about device approval. */
export const TEST_DEVICE = {
  deviceId: "00000000-0000-4000-8000-00000000d0d0",
  deviceSecret: "test-device-secret-test-device-secret-0000",
};

const SIGN_IN = new Set(["/api/v1/auth/login", "/api/v1/auth/login/device-key"]);

/**
 * buildApp for tests that predate device approval (ADR-0009): sign-ins
 * without a device identity get TEST_DEVICE, and a DEVICE_APPROVAL_REQUIRED
 * answer is approved through the server-console path and retried — exactly
 * what an admin would do. Tests that exercise approval send their own
 * identities and are left alone.
 */
export async function buildTestApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = await buildApp(opts);
  const inject = app.inject.bind(app) as (o: InjectOptions) => ReturnType<FastifyInstance["inject"]>;
  (app as { inject: unknown }).inject = async (o: InjectOptions) => {
    const payload = o.payload as Record<string, unknown> | undefined;
    if (!o.url || !SIGN_IN.has(String(o.url)) || !payload || typeof payload !== "object" || "deviceId" in payload) {
      return inject(o);
    }
    const withDevice = { ...o, payload: { ...payload, ...TEST_DEVICE } };
    const res = await inject(withDevice);
    if (res.statusCode !== 403) return res;
    const body = res.json() as { error?: { code?: string; fields?: { code?: string } } };
    if (body.error?.code !== "DEVICE_APPROVAL_REQUIRED" || !body.error.fields?.code) return res;
    await approveFromConsole(app.db, body.error.fields.code, { override: true });
    return inject(withDevice);
  };
  return app;
}
