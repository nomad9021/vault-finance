import { z } from "zod";

/**
 * Health checks shown on the desktop app's startup screen and in
 * Settings → System status. Every check is phrased for the person using the
 * app: `detail` says what was found, `hint` says what to do about it.
 *
 *   ok    — working
 *   warn  — works, but something needs attention (the app still opens)
 *   error — this blocks the app (the startup screen stops and explains)
 *   off   — an optional feature that's turned off; not a fault
 */
export const StatusLevel = z.enum(["ok", "warn", "error", "off"]);
export type StatusLevel = z.infer<typeof StatusLevel>;

export const StatusCheck = z.object({
  id: z.string(),
  label: z.string(),
  level: StatusLevel,
  detail: z.string().optional(),
  hint: z.string().optional(),
});
export type StatusCheck = z.infer<typeof StatusCheck>;

/**
 * GET /status — unauthenticated, so the startup screen can run it before
 * sign-in. Deliberately coarse: component health only, no household data.
 */
export const ServerStatusResponse = z.object({
  apiVersion: z.string(),
  startedAt: z.string(),
  checks: z.array(StatusCheck),
});
export type ServerStatusResponse = z.infer<typeof ServerStatusResponse>;

/** GET /status/details — signed in: AI, bank sync, and server update checks. */
export const StatusDetailsResponse = z.object({
  checks: z.array(StatusCheck),
});
export type StatusDetailsResponse = z.infer<typeof StatusDetailsResponse>;

/** Worst level in a list (error > warn > ok/off). */
export function worstLevel(checks: Array<Pick<StatusCheck, "level">>): StatusLevel {
  if (checks.some((c) => c.level === "error")) return "error";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "ok";
}
