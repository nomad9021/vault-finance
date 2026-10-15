import { statfs } from "node:fs/promises";
import {
  AI_PROVIDER_LABELS,
  type ServerStatusResponse,
  type StatusCheck,
  type StatusDetailsResponse,
} from "@vault/shared";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import { bankConnections } from "../../db/schema.js";
import { resolveSettings, statusFor } from "../ai/settings.js";
import { isConfigured as bankConfigured } from "../bank/providers/index.js";
import { autoSyncFaults, loadBankSettings, providerConfig } from "../bank/service.js";
import { getUpdateStatus } from "../updates/service.js";

const STARTED_AT = new Date().toISOString();
const GB = 1024 ** 3;

/**
 * Health checks for the desktop app's startup screen and Settings → System
 * status. `/status` is public (the startup screen runs before sign-in) so it
 * only reports component health; `/status/details` needs a session.
 */
export default async function statusRoutes(app: FastifyInstance, opts: { config: AppConfig }) {
  app.get("/status", async (): Promise<ServerStatusResponse> => {
    const checks = await Promise.all([databaseCheck(app), storageCheck(opts.config.dataDir)]);
    return { apiVersion: opts.config.apiVersion, startedAt: STARTED_AT, checks };
  });

  app.get(
    "/status/details",
    { preHandler: [app.requireAuth] },
    async (request): Promise<StatusDetailsResponse> => {
      const checks = await Promise.all([
        aiCheck(app, opts.config).catch((err) => failed("ai", "AI assistant", err, request)),
        bankCheck(app, opts.config).catch((err) => failed("bank", "Bank sync", err, request)),
        updateCheck(app, opts.config).catch((err) => failed("server-update", "Server version", err, request)),
      ]);
      return { checks };
    },
  );
}

function failed(id: string, label: string, err: unknown, request: { log: FastifyInstance["log"] }): StatusCheck {
  request.log.warn({ err, check: id }, "status check threw");
  return { id, label, level: "warn", detail: "This check couldn't run.", hint: "See the server log for details." };
}

async function databaseCheck(app: FastifyInstance): Promise<StatusCheck> {
  const started = Date.now();
  try {
    await Promise.race([
      app.db.execute(sql`select 1`),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 3_000)),
    ]);
    const ms = Date.now() - started;
    return ms > 1_000
      ? {
          id: "database",
          label: "Database",
          level: "warn",
          detail: `Responding slowly (${ms} ms).`,
          hint: "The server machine may be overloaded or its disk busy.",
        }
      : { id: "database", label: "Database", level: "ok", detail: "Connected." };
  } catch {
    return {
      id: "database",
      label: "Database",
      level: "error",
      detail: "The server can't reach its database.",
      hint: "On the server machine, run “docker compose ps” in the vault-finance/docker folder — the postgres container should be running. “docker compose up -d” starts it.",
    };
  }
}

async function storageCheck(dataDir: string): Promise<StatusCheck> {
  try {
    const s = await statfs(dataDir);
    const free = s.bavail * s.bsize;
    const freeText = free >= GB ? `${(free / GB).toFixed(1)} GB free` : `${Math.round(free / 1024 ** 2)} MB free`;
    if (free < 0.3 * GB) {
      return {
        id: "storage",
        label: "Server storage",
        level: "error",
        detail: `Almost full — ${freeText}. Saving changes may fail.`,
        hint: "Free up space on the server's data drive, or move the data folder to a bigger drive (see docs/operations.md).",
      };
    }
    if (free < 2 * GB) {
      return {
        id: "storage",
        label: "Server storage",
        level: "warn",
        detail: `Running low — ${freeText}.`,
        hint: "Free up space on the server's data drive soon.",
      };
    }
    return { id: "storage", label: "Server storage", level: "ok", detail: freeText };
  } catch {
    return { id: "storage", label: "Server storage", level: "warn", detail: "Couldn't check free space." };
  }
}

async function aiCheck(app: FastifyInstance, config: AppConfig): Promise<StatusCheck> {
  const status = await statusFor(await resolveSettings(app, config));
  const label = "AI assistant";
  if (!status.enabled) return { id: "ai", label, level: "off", detail: "Turned off." };
  const name = AI_PROVIDER_LABELS[status.provider];
  if (!status.configured) {
    return { id: "ai", label, level: "warn", detail: `${name} isn't set up yet.`, hint: "Finish setting it up in Settings → AI assistant." };
  }
  if (!status.reachable) {
    return {
      id: "ai",
      label,
      level: "warn",
      detail: status.error ?? `Can't reach ${name}.`,
      ...(status.hint ? { hint: status.hint } : {}),
    };
  }
  const n = status.availableModels.length;
  return { id: "ai", label, level: "ok", detail: `Connected to ${name}${n ? ` · ${n} model${n === 1 ? "" : "s"}` : ""}.` };
}

async function bankCheck(app: FastifyInstance, config: AppConfig): Promise<StatusCheck> {
  const label = "Bank sync";
  const settings = await loadBankSettings(app.db);
  if (!settings.enabled) return { id: "bank", label, level: "off", detail: "Bank linking is turned off." };
  if (!bankConfigured(providerConfig(settings, config.plaidBaseUrl))) {
    return {
      id: "bank",
      label,
      level: "warn",
      detail: "Bank linking is on, but the provider isn't fully set up.",
      hint: "Add the missing keys in Settings → Connected banks.",
    };
  }
  const conns = await app.db.select().from(bankConnections);
  if (conns.length === 0) return { id: "bank", label, level: "ok", detail: "Ready — no banks connected yet." };

  const faulty = conns.filter((c) => autoSyncFaults.has(c.id));
  if (faulty.length > 0) {
    const first = faulty[0]!;
    return {
      id: "bank",
      label,
      level: "warn",
      detail: `Automatic sync failed for ${first.institutionName}${faulty.length > 1 ? ` and ${faulty.length - 1} more` : ""}.`,
      hint: `${autoSyncFaults.get(first.id)!.message} — try Sync in Settings → Connected banks.`,
    };
  }

  const minutes = config.bankAutoSyncMinutes;
  if (minutes > 0) {
    const staleAfter = Math.max(3 * minutes, 6 * 60) * 60_000;
    const stale = conns.filter((c) => !c.lastSyncedAt || Date.now() - c.lastSyncedAt.getTime() > staleAfter);
    if (stale.length > 0) {
      const s = stale[0]!;
      return {
        id: "bank",
        label,
        level: "warn",
        detail: s.lastSyncedAt
          ? `${s.institutionName} hasn't synced since ${s.lastSyncedAt.toISOString().slice(0, 16).replace("T", " ")} UTC.`
          : `${s.institutionName} has never synced.`,
        hint: "Check the server has internet access, then press Sync in Settings → Connected banks.",
      };
    }
  }
  return { id: "bank", label, level: "ok", detail: `${conns.length} connection${conns.length === 1 ? "" : "s"} syncing.` };
}

async function updateCheck(app: FastifyInstance, config: AppConfig): Promise<StatusCheck> {
  const s = await getUpdateStatus(app.db, config, app.log);
  const label = "Server version";
  if (s.updateAvailable && s.latestVersion && !s.operatorManaged) {
    return {
      id: "server-update",
      label,
      level: "warn",
      detail: `Running ${s.currentVersion}; ${s.latestVersion} is available.`,
      hint: "The owner can install it from Settings → Server update.",
    };
  }
  return { id: "server-update", label, level: "ok", detail: `Up to date (${s.currentVersion}).` };
}
