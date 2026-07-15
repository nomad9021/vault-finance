import { z } from "zod";

export const VersionResponse = z.object({
  apiVersion: z.string(),
  minClientVersion: z.string(),
});
export type VersionResponse = z.infer<typeof VersionResponse>;

/**
 * Compare two semver strings ("1.2.3"). Returns negative if a < b, 0 if equal,
 * positive if a > b. Deliberately tiny — no ranges, no prerelease — because the
 * version-compatibility check only ever compares plain release versions.
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
