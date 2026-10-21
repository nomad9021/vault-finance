import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SelfUpdateStatus } from "@vault/shared";

/**
 * File handshake with the host's update agent (installers/server/update-agent.sh).
 * The server never touches Docker itself: it can only drop `request.json` into
 * the shared folder. A systemd path unit on the host notices it, runs the
 * normal update script and reports back in `status.json`. `agent.json` is
 * written by enable-app-updates.sh and marks the agent as installed.
 */
const AGENT_FILE = "agent.json";
const REQUEST_FILE = "request.json";
const STATUS_FILE = "status.json";

/** The agent picks a request up within seconds; after this, assume it's not running. */
const REQUEST_TIMEOUT_MS = 2 * 60_000;
/** Pulling images on a slow link can take a while, but not this long. */
const RUN_TIMEOUT_MS = 30 * 60_000;

function mtimeMs(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function readAgentStatus(dir: string): SelfUpdateStatus | null {
  try {
    const parsed = SelfUpdateStatus.safeParse(JSON.parse(readFileSync(path.join(dir, STATUS_FILE), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const idle: SelfUpdateStatus = {
  state: "idle",
  message: null,
  targetVersion: null,
  startedAt: null,
  finishedAt: null,
};

/** Where an in-app update stands, or null when no agent is installed. */
export function readSelfUpdate(dir: string | null, now = Date.now()): SelfUpdateStatus | null {
  if (!dir || mtimeMs(path.join(dir, AGENT_FILE)) === null) return null;

  const requestedAt = mtimeMs(path.join(dir, REQUEST_FILE));
  if (requestedAt !== null) {
    let targetVersion: string | null = null;
    try {
      const req = JSON.parse(readFileSync(path.join(dir, REQUEST_FILE), "utf8")) as { targetVersion?: unknown };
      if (typeof req.targetVersion === "string") targetVersion = req.targetVersion;
    } catch {
      /* unreadable request still counts as pending */
    }
    const startedAt = new Date(requestedAt).toISOString();
    if (now - requestedAt > REQUEST_TIMEOUT_MS) {
      return {
        state: "failed",
        message:
          "The server's update agent didn't pick up the request. On the server, check it with: systemctl status vault-update.path",
        targetVersion,
        startedAt,
        finishedAt: null,
      };
    }
    return { state: "requested", message: null, targetVersion, startedAt, finishedAt: null };
  }

  const status = readAgentStatus(dir);
  if (!status) return idle;
  if (status.state === "running" && status.startedAt && now - Date.parse(status.startedAt) > RUN_TIMEOUT_MS) {
    return {
      ...status,
      state: "failed",
      message: "The update has been running for over 30 minutes. Check last-update.log in the server's data folder.",
    };
  }
  return status;
}

/** Hand the update to the agent. Written atomically so it never sees half a file. */
export function writeUpdateRequest(
  dir: string,
  request: { targetVersion: string; fromVersion: string; requestedBy: string },
): void {
  const tmp = path.join(dir, `.${REQUEST_FILE}.tmp`);
  writeFileSync(tmp, JSON.stringify({ ...request, requestedAt: new Date().toISOString() }) + "\n", {
    mode: 0o644,
  });
  renameSync(tmp, path.join(dir, REQUEST_FILE));
}
