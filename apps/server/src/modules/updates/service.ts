import { compareSemver } from "@vault/shared";
import type { UpdateStatusResponse } from "@vault/shared";
import type { FastifyBaseLogger } from "fastify";
import { readMeta, writeMeta } from "../../lib/app-meta.js";
import type { Db } from "../../plugins/db.js";
import type { AppConfig } from "../../config.js";

const META_KEY = "update_check";
/** Version we last emailed the owner about — don't re-notify for the same one. */
const NOTIFIED_KEY = "update_notified_version";

interface CachedCheck {
  latestVersion: string | null;
  notesUrl: string | null;
  checkedAt: string; // ISO
}

/** Strip a leading "v" and any pre-release/build suffix drizzle-tiny semver can't parse. */
function normalizeVersion(tag: string): string {
  const m = /(\d+\.\d+\.\d+)/.exec(tag.trim());
  return m ? m[1]! : tag.trim().replace(/^v/, "");
}

/**
 * Fetch the latest published release from the manifest URL (GitHub releases API
 * by default). Best-effort: returns null on any network/parse failure.
 */
export async function fetchLatestRelease(
  manifestUrl: string,
  log: FastifyBaseLogger,
): Promise<{ version: string; notesUrl: string | null } | null> {
  try {
    const res = await fetch(manifestUrl, {
      headers: { accept: "application/vnd.github+json", "user-agent": "vault-finance-server" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log.warn({ status: res.status }, "update check: manifest request failed");
      return null;
    }
    const body = (await res.json()) as { tag_name?: string; html_url?: string; name?: string };
    const tag = body.tag_name ?? body.name;
    if (!tag) return null;
    return { version: normalizeVersion(tag), notesUrl: body.html_url ?? null };
  } catch (err) {
    log.warn({ err }, "update check: could not reach the release manifest");
    return null;
  }
}

function toStatus(config: AppConfig, cached: CachedCheck | null): UpdateStatusResponse {
  const latestVersion = cached?.latestVersion ?? null;
  return {
    currentVersion: config.apiVersion,
    latestVersion,
    updateAvailable:
      latestVersion !== null && compareSemver(latestVersion, config.apiVersion) > 0,
    notesUrl: cached?.notesUrl ?? null,
    operatorManaged: config.updates.operatorManaged,
    checkedAt: cached?.checkedAt ?? null,
  };
}

/** Run the check, persist the result, and return the current status. */
export async function refreshUpdateStatus(
  db: Db,
  config: AppConfig,
  log: FastifyBaseLogger,
): Promise<UpdateStatusResponse> {
  const latest = await fetchLatestRelease(config.updates.manifestUrl, log);
  const prev = await getCachedCheck(db);
  const cached: CachedCheck = {
    latestVersion: latest?.version ?? prev?.latestVersion ?? null,
    notesUrl: latest?.notesUrl ?? prev?.notesUrl ?? null,
    checkedAt: new Date().toISOString(),
  };
  await writeMeta(db, META_KEY, JSON.stringify(cached));
  return toStatus(config, cached);
}

async function getCachedCheck(db: Db): Promise<CachedCheck | null> {
  const raw = await readMeta(db, META_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CachedCheck;
  } catch {
    return null;
  }
}

/** Cached status; refreshes in-line when the cache is missing or older than a day. */
export async function getUpdateStatus(
  db: Db,
  config: AppConfig,
  log: FastifyBaseLogger,
): Promise<UpdateStatusResponse> {
  const cached = await getCachedCheck(db);
  const stale =
    !cached || Date.now() - Date.parse(cached.checkedAt) > 25 * 60 * 60_000;
  if (stale) return refreshUpdateStatus(db, config, log);
  return toStatus(config, cached);
}

export async function getNotifiedVersion(db: Db): Promise<string | null> {
  return readMeta(db, NOTIFIED_KEY);
}
export async function setNotifiedVersion(db: Db, version: string): Promise<void> {
  await writeMeta(db, NOTIFIED_KEY, version);
}
