import { once } from "node:events";
import { request } from "node:http";
import { isIP } from "node:net";
import { connect, type TLSSocket } from "node:tls";
import { LOCAL_PROVIDERS, type AiHostStatus } from "@vault/shared";
import type { AppConfig } from "../../config.js";
import { getProvider, isConfigured } from "./providers/index.js";
import type { ResolvedAiSettings } from "./settings.js";

type ProxmoxTarget = NonNullable<AppConfig["aiHost"]>;

/** A start request counts as "starting" for this long while the VM boots. */
const START_GRACE_MS = 3 * 60_000;

export class ProxmoxError extends Error {}

/** "aa:BB:cc…" / "AABBCC…" → "AABBCC…" so either way of writing it compares equal. */
function normalizeFingerprint(fp: string): string {
  return fp.replace(/[^0-9a-f]/gi, "").toUpperCase();
}

/**
 * Open TLS to Proxmox and check its certificate BEFORE any request (and so
 * the API token) is sent. Proxmox ships a self-signed certificate, so it's
 * pinned by fingerprint like the desktop app pins the Vault server (ADR-0004);
 * without a fingerprint the certificate must be publicly trusted.
 */
async function openPinned(target: ProxmoxTarget): Promise<TLSSocket> {
  const url = new URL(target.proxmoxUrl);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const socket = connect({
    host,
    port: Number(url.port || 8006),
    ...(isIP(host) ? {} : { servername: host }),
    rejectUnauthorized: !target.fingerprint,
  });
  socket.setTimeout(5_000, () => socket.destroy(new ProxmoxError("Proxmox didn't answer within 5 seconds.")));
  try {
    await once(socket, "secureConnect");
  } catch (err) {
    socket.destroy();
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (err instanceof ProxmoxError) throw err;
    if (code.startsWith("ERR_TLS") || code.includes("CERT") || code === "DEPTH_ZERO_SELF_SIGNED_CERT") {
      throw new ProxmoxError(
        "Proxmox's certificate isn't trusted. Set AI_HOST_PROXMOX_FINGERPRINT to its SHA-256 fingerprint.",
      );
    }
    throw new ProxmoxError(`Can't reach Proxmox at ${target.proxmoxUrl} (${code || (err as Error).message}).`);
  }
  if (target.fingerprint) {
    const seen = normalizeFingerprint(socket.getPeerCertificate().fingerprint256 ?? "");
    if (seen !== normalizeFingerprint(target.fingerprint)) {
      socket.destroy();
      throw new ProxmoxError(
        "Proxmox's certificate doesn't match AI_HOST_PROXMOX_FINGERPRINT. If you renewed its certificate, update the fingerprint.",
      );
    }
  }
  return socket;
}

async function proxmox(target: ProxmoxTarget, method: "GET" | "POST", apiPath: string): Promise<unknown> {
  const socket = await openPinned(target);
  const url = new URL(target.proxmoxUrl);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        createConnection: () => socket,
        host: url.hostname,
        method,
        path: `/api2/json${apiPath}`,
        headers: { authorization: `PVEAPIToken=${target.token}` },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => {
          socket.destroy();
          if (res.statusCode === 401) {
            return reject(new ProxmoxError("Proxmox rejected the API token (AI_HOST_PROXMOX_TOKEN)."));
          }
          if (res.statusCode === 403) {
            return reject(
              new ProxmoxError(
                `The Proxmox token isn't allowed to manage VM ${target.vmid}. It needs VM.Audit and VM.PowerMgmt on /vms/${target.vmid}.`,
              ),
            );
          }
          if (!res.statusCode || res.statusCode >= 400) {
            return reject(new ProxmoxError(`Proxmox returned ${res.statusCode}: ${body.slice(0, 200)}`));
          }
          try {
            resolve((JSON.parse(body) as { data?: unknown }).data);
          } catch {
            reject(new ProxmoxError("Proxmox sent a response Vault couldn't read."));
          }
        });
      },
    );
    req.on("error", (err) => {
      socket.destroy();
      reject(err instanceof ProxmoxError ? err : new ProxmoxError(`Proxmox request failed: ${err.message}`));
    });
    req.end();
  });
}

const vmPath = (t: ProxmoxTarget) =>
  `/nodes/${encodeURIComponent(t.node)}/qemu/${t.vmid}/status`;

export async function vmRunning(target: ProxmoxTarget): Promise<boolean> {
  const data = (await proxmox(target, "GET", `${vmPath(target)}/current`)) as { status?: string } | null;
  return data?.status === "running";
}

export async function startVm(target: ProxmoxTarget): Promise<void> {
  await proxmox(target, "POST", `${vmPath(target)}/start`);
}

/**
 * The AI gateway's /health (see the ai-server repo): reachable without a key
 * and reports the queue. Plain Ollama or other servers don't have it.
 */
async function gatewayHealth(baseUrl: string): Promise<{ active: number; waiting: number } | null> {
  try {
    const res = await fetch(new URL("/health", baseUrl), { signal: AbortSignal.timeout(2_500) });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok?: boolean; active?: unknown; waiting?: unknown };
    if (body.ok !== true || typeof body.active !== "number" || typeof body.waiting !== "number") return null;
    return { active: body.active, waiting: body.waiting };
  } catch {
    return null;
  }
}

/** Power state of the separate AI server, plus the Start action. */
export function createAiHost(config: AppConfig) {
  const target = config.aiHost;
  let startRequestedAt = 0;

  async function status(settings: ResolvedAiSettings): Promise<AiHostStatus> {
    const { aiConfig } = settings;
    const applies = settings.enabled && LOCAL_PROVIDERS.has(aiConfig.provider) && isConfigured(aiConfig);
    const canStart = Boolean(target);
    if (!applies) return { applies: false, power: "unknown", canStart };

    const gateway = await gatewayHealth(aiConfig.baseUrl);
    let reachable = gateway !== null;
    if (!reachable) {
      reachable = await getProvider(aiConfig.provider)
        .listModels(aiConfig)
        .then(() => true)
        .catch(() => false);
    }
    const queue = gateway ? { queue: gateway } : {};
    if (reachable) {
      startRequestedAt = 0;
      return { applies, power: "on", canStart, ...queue };
    }
    if (!target) return { applies, power: "off", canStart };

    const justStarted = Date.now() - startRequestedAt < START_GRACE_MS;
    try {
      const running = await vmRunning(target);
      return { applies, power: running || justStarted ? "starting" : "off", canStart };
    } catch (err) {
      return { applies, power: "unknown", canStart, message: (err as Error).message };
    }
  }

  /** Switch the VM on; a no-op while it's already running or booting. */
  async function start(): Promise<void> {
    if (!target) throw new ProxmoxError("Vault isn't set up to start the AI server (no Proxmox token).");
    if (await vmRunning(target)) return;
    await startVm(target);
    startRequestedAt = Date.now();
  }

  return { status, start, canStart: Boolean(target) };
}
