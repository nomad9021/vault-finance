import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ControlFamily } from "@vault/shared";

const exec = promisify(execFile);

const FAMILYCTL = process.env["FAMILYCTL"] ?? "/repo/docker/multi/familyctl.sh";
const FAMILIES_DIR = process.env["FAMILIES_DIR"] ?? path.join(path.dirname(FAMILYCTL), "families");

export interface FamilyctlResult {
  ok: boolean;
  log: string;
}

/** Run familyctl with args. Never throws — captures stdout+stderr and the exit status. */
export async function familyctl(args: string[]): Promise<FamilyctlResult> {
  try {
    const { stdout, stderr } = await exec("bash", [FAMILYCTL, ...args], {
      timeout: 5 * 60_000,
      maxBuffer: 4 * 1024 * 1024,
      // The control plane has already confirmed the action in its own UI.
      env: { ...process.env, FAMILYCTL_ASSUME_YES: "1" },
    });
    return { ok: true, log: stripAnsi(stdout + stderr) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, log: stripAnsi((e.stdout ?? "") + (e.stderr ?? "") + (e.message ?? "")) };
  }
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, "");
}

function readEnvFile(slug: string): Record<string, string> {
  try {
    const raw = readFileSync(path.join(FAMILIES_DIR, slug, "family.env"), "utf8");
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return out;
  } catch {
    return {};
  }
}

/** Parse `familyctl list` fixed-width output into structured rows. */
export async function listFamilies(): Promise<ControlFamily[]> {
  const { log } = await familyctl(["list"]);
  const lines = log.split("\n").filter((l) => l.trim() && !l.startsWith("SLUG"));
  const families: ControlFamily[] = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const [slug, port, mode, domain, state, ...sizeParts] = parts;
    if (!slug || !port) continue;
    const env = readEnvFile(slug);
    families.push({
      slug,
      port,
      mode: mode === "proxy" ? "proxy" : "port",
      domain: domain && domain !== "-" ? domain : null,
      state: state ?? "-",
      dbSize: sizeParts.join(" ") || "?",
      ownerEmail: env["OWNER_EMAIL"] || null,
      appPublicUrl: env["APP_PUBLIC_URL"] || null,
      runningVersion: null, // filled in by the caller (needs a network hop)
      createdAt: env["CREATED"] || null,
    });
  }
  return families;
}

/**
 * Ask a running family server for its version over the shared docker network.
 * Family servers use self-signed certs by design (ADR-0004); the control
 * container sets NODE_TLS_REJECT_UNAUTHORIZED=0 because every host it talks to
 * is one of those internal servers (see docker/multi/docker-compose.base.yml).
 */
export async function familyVersion(slug: string): Promise<string | null> {
  try {
    const res = await fetch(`https://vault-${slug}:8443/api/v1/version`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { apiVersion?: string };
    return body.apiVersion ?? null;
  } catch {
    return null;
  }
}
