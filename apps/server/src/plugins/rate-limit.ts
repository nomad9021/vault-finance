import fp from "fastify-plugin";
import { rateLimited } from "../errors.js";

/**
 * In-memory sliding-window rate limiting, applied globally per client IP.
 *
 * Two tiers:
 *  - a generous global ceiling that stops request floods without touching
 *    normal use (the desktop app polls a handful of endpoints);
 *  - a strict tier for unauthenticated credential endpoints (login, refresh,
 *    2FA, setup) to blunt brute-force independently of the per-identifier
 *    limiter already inside the auth module.
 *
 * Single-household scale, so in-memory is proportionate; a Redis-backed store
 * can replace this transparently later (mirrors the note in auth/routes.ts).
 */
function makeWindow(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const now = Date.now();
    const windowStart = now - windowMs;
    const list = (hits.get(key) ?? []).filter((t) => t > windowStart);
    list.push(now);
    hits.set(key, list);
    if (hits.size > 50_000) {
      for (const [k, v] of hits) {
        if (v.every((t) => t <= windowStart)) hits.delete(k);
      }
    }
    return list.length <= max;
  };
}

// Unauthenticated credential endpoints get the strict tier. Matched against the
// path after the /api/v1 prefix is stripped.
const SENSITIVE = [
  "/auth/login",
  "/auth/refresh",
  "/auth/2fa/enable",
  "/auth/2fa/disable",
  "/setup/complete",
];

// Unauthenticated endpoints whose path carries a token/id segment — matched by
// prefix rather than exact equality.
const SENSITIVE_PREFIXES = ["/members/invite"];

export default fp(
  async (app, opts?: { globalMax?: number; sensitiveMax?: number }) => {
    const globalAllow = makeWindow(opts?.globalMax ?? 600, 60_000); // 600/min/IP
    const sensitiveAllow = makeWindow(opts?.sensitiveMax ?? 20, 15 * 60_000); // 20/15min/IP

    app.addHook("onRequest", async (request) => {
      const ip = request.ip || "unknown";
      const path = request.url.split("?")[0] ?? "";
      const rel = path.startsWith("/api/v1") ? path.slice("/api/v1".length) : path;

      if (SENSITIVE.some((p) => rel === p)) {
        if (!sensitiveAllow(`s:${ip}:${rel}`)) throw rateLimited();
      }
      const prefix = SENSITIVE_PREFIXES.find((p) => rel.startsWith(p));
      if (prefix) {
        if (!sensitiveAllow(`s:${ip}:${prefix}`)) throw rateLimited();
      }
      if (!globalAllow(`g:${ip}`)) throw rateLimited();
    });
  },
  { name: "rate-limit" },
);
