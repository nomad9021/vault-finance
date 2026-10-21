import { z } from "zod";

/**
 * Progress of an update started from the app. The host's update agent
 * (installers/server/enable-app-updates.sh) does the work; the server only
 * passes the request along and reads back what the agent reports.
 */
export const SelfUpdateStatus = z.object({
  state: z.enum(["idle", "requested", "running", "succeeded", "failed"]),
  /** Plain-language detail for the current state (e.g. why it failed). */
  message: z.string().nullable(),
  /** Version the update was started for, when one has been started. */
  targetVersion: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type SelfUpdateStatus = z.infer<typeof SelfUpdateStatus>;

export const UpdateStatusResponse = z.object({
  /** Semver this server is running. */
  currentVersion: z.string(),
  /** Latest published release, or null when the check couldn't reach the manifest. */
  latestVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  /** Link to the release notes for `latestVersion`, when known. */
  notesUrl: z.string().nullable(),
  /** True when this server is part of an operator-managed fleet (owner doesn't self-update). */
  operatorManaged: z.boolean(),
  /** When the check last ran, ISO-8601, or null if it hasn't yet. */
  checkedAt: z.string().datetime().nullable(),
  /**
   * In-app updating: null when this server's host has no update agent set up
   * (or is operator-managed). Absent on servers older than 0.1.8.
   */
  selfUpdate: SelfUpdateStatus.nullable().optional(),
});
export type UpdateStatusResponse = z.infer<typeof UpdateStatusResponse>;
