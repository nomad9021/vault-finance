import { z } from "zod";

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
});
export type UpdateStatusResponse = z.infer<typeof UpdateStatusResponse>;
