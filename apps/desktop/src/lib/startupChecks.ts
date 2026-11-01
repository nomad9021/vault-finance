import {
  ApiRequestError,
  compareSemver,
  type ApiClient,
  type StatusCheck,
  type StatusLevel,
} from "@vault/shared";
import type { HostPlatform, ProbeResult, TailscaleStatus } from "../platform/index.js";
import { pickAddress } from "./serverRoute.js";
import {
  getPrivateNetwork,
  networkName,
  PRIVATE_NETWORKS,
  type PrivateNetworkId,
  usesTailscaleClient,
} from "./privateNetwork.js";

/**
 * The startup screen's health checks, in the order a connection actually
 * depends on them: this computer → private network → reaching the server → its
 * identity → version compatibility → the server's own components → (signed
 * in) AI, bank sync, server updates. Each check is phrased for the person
 * using the app, with what to do next. Settings → System status reuses this.
 */

export type CheckAction =
  | "tailscale-up"
  | "tailscale-login"
  | "tailscale-install"
  | "change-server"
  | "update-app";

export interface UiCheck {
  id: string;
  label: string;
  level: StatusLevel | "pending";
  detail?: string;
  hint?: string;
  action?: CheckAction;
}

export interface CheckDeps {
  platform: HostPlatform;
  client: ApiClient;
  address: string;
  appVersion: string;
  /** Whether the OS keychain answered at boot. */
  keychainOk: boolean;
  /** A saved session exists, so the signed-in checks can run. */
  hasSession: boolean;
  /** How this computer reaches the server away from home; defaults to the saved choice. */
  network?: PrivateNetworkId;
  /** The server's other address; the first of the two to answer gets used. */
  alternateAddress?: string | null;
  /** Told which address answered, before any request that depends on it. */
  onRoute?: (address: string) => void;
}

export interface CheckOutcome {
  checks: UiCheck[];
  /** Something blocks opening the app (any "error"). */
  blocked: boolean;
  probe: ProbeResult | null;
  tailscale: TailscaleStatus | null;
}

export const TAILSCALE_DOWNLOAD_URL = "https://tailscale.com/download";

/** Tailscale addresses: 100.64.0.0/10, the fd7a:115c:a1e0::/48 range, or a *.ts.net name. */
export function looksLikeTailnet(address: string): boolean {
  let host: string;
  try {
    host = new URL(address).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return false;
  }
  if (host.endsWith(".ts.net")) return true;
  if (host.startsWith("fd7a:115c:a1e0:")) return true;
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(host);
  return m !== null && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

function hostPort(address: string): { host: string; port: string } {
  try {
    const u = new URL(address);
    return { host: u.hostname, port: u.port || (u.protocol === "https:" ? "443" : "80") };
  } catch {
    return { host: address, port: "8443" };
  }
}

/** Turn a failed probe into what happened and what to try. */
export function describeProbeFailure(
  probe: ProbeResult,
  address: string,
  network: PrivateNetworkId = getPrivateNetwork(),
): { detail: string; hint: string } {
  const { host, port } = hostPort(address);
  const vpn = networkName(network);
  if (probe.httpStatus !== undefined) {
    return {
      detail: `Something answered at ${host}:${port}, but it isn't a Vault Finance server (HTTP ${probe.httpStatus}).`,
      hint: "Check the port number — the Vault server uses 8443 unless you changed it.",
    };
  }
  const e = (probe.error ?? "").toLowerCase();
  if (/dns error|failed to lookup|name or service not known|no such host|nodename nor servname|name resolution/.test(e)) {
    return {
      detail: `Couldn't find a computer called “${host}”.`,
      hint: `Check the spelling, or use the server's IP address.${vpn ? ` If it's a name on ${vpn}, ${vpn} has to be on.` : ""}`,
    };
  }
  if (/connection refused|actively refused/.test(e)) {
    return {
      detail: `${host} answered, but the Vault server isn't running on port ${port}.`,
      hint: "On the server machine, start it from the vault-finance/docker folder with: docker compose up -d",
    };
  }
  if (/timed out|timeout|deadline|no route to host|network is unreachable|host is unreachable/.test(e)) {
    return {
      detail: `No answer from ${host}.`,
      hint: looksLikeTailnet(address)
        ? `This address only works through ${vpn ?? "a VPN"}. Turn it on, or choose Change server and use the server's home network address.`
        : `Make sure the server machine is switched on.${vpn ? ` If you reach it through ${vpn}, make sure that's connected.` : ""}`,
    };
  }
  if (/certificate|tls|handshake|ssl/.test(e)) {
    return {
      detail: "A secure connection to the server couldn't be set up.",
      hint: "Make sure the address starts with https://, then try again. If it keeps happening, check the server's certificate.",
    };
  }
  return {
    detail: `Couldn't reach the server at ${host}:${port}.`,
    hint: probe.error ? `Details: ${probe.error.slice(0, 160)}` : "Check the address and that the server is running.",
  };
}

/**
 * The Tailscale row. Being off is normal (at home, say), so this row never
 * blocks anything: whether the server answers is the only test that matters,
 * and `serverDown` just raises Tailscale to a likely culprit worth fixing.
 */
export function tailscaleCheck(ts: TailscaleStatus, address: string, serverDown: boolean, label = "Tailscale"): UiCheck {
  const needed = looksLikeTailnet(address);
  const notNeeded = "Not needed right now: the server is reachable.";
  if (!ts.installed) {
    return serverDown && needed
      ? {
          id: "tailscale",
          label,
          level: "warn",
          detail: `This server's address is on ${label}, but Tailscale isn't installed on this computer.`,
          hint: "Install Tailscale and sign in with the same account as the server.",
          action: "tailscale-install",
        }
      : { id: "tailscale", label, level: "off", detail: "Not installed." };
  }
  switch (ts.state) {
    case "Running": {
      const ip = ts.ips.find((i) => !i.includes(":")) ?? ts.ips[0];
      const who = [ts.dnsName?.split(".")[0], ip].filter(Boolean).join(" · ");
      if (ts.health.length > 0) {
        return {
          id: "tailscale",
          label,
          level: "warn",
          detail: `Connected${who ? ` (${who})` : ""}, with a problem.`,
          hint: ts.health[0]!,
        };
      }
      return { id: "tailscale", label, level: "ok", detail: `Connected${who ? ` (${who})` : ""}.` };
    }
    case "NeedsLogin":
    case "NeedsMachineAuth":
      if (!serverDown) return { id: "tailscale", label, level: "off", detail: `Signed out. ${notNeeded}` };
      return {
        id: "tailscale",
        label,
        level: "warn",
        detail:
          ts.state === "NeedsMachineAuth"
            ? `This computer is waiting for approval in your ${label} admin console.`
            : `${label} needs you to sign in.`,
        hint: `Sign in with the same ${label} account as your server.`,
        ...(ts.state === "NeedsLogin" ? { action: "tailscale-login" as const } : {}),
      };
    case "DaemonDown":
      if (!serverDown) return { id: "tailscale", label, level: "off", detail: `Service not running. ${notNeeded}` };
      return {
        id: "tailscale",
        label,
        level: "warn",
        detail: ts.error ?? "The Tailscale service isn't running.",
        hint: "Start the Tailscale app (or the tailscaled service), then retry.",
      };
    case "Starting":
      return { id: "tailscale", label, level: serverDown ? "warn" : "off", detail: "Connecting…" };
    default:
      return serverDown
        ? {
            id: "tailscale",
            label,
            level: "warn",
            detail: needed
              ? `${label} is off, and this server's address only works through it.`
              : `${label} is off. If your server is on ${label}, that's why it can't be reached.`,
            action: "tailscale-up",
          }
        : { id: "tailscale", label, level: "off", detail: `Off. ${notNeeded}`, action: "tailscale-up" };
  }
}

function fromServer(c: StatusCheck): UiCheck {
  return {
    id: c.id,
    label: c.label,
    level: c.level,
    ...(c.detail ? { detail: c.detail } : {}),
    ...(c.hint ? { hint: c.hint } : {}),
  };
}

/**
 * Run every check, reporting progress through `onUpdate` so the startup
 * screen fills in row by row. Stops early at the first check that makes the
 * rest meaningless (can't reach the server, identity changed…).
 */
export async function runChecks(deps: CheckDeps, onUpdate: (checks: UiCheck[]) => void): Promise<CheckOutcome> {
  const { platform, client, address: primary, alternateAddress: alternate } = deps;
  const network = deps.network ?? getPrivateNetwork();
  const canReadNetwork = usesTailscaleClient(network) && platform.tailscaleStatus !== undefined;
  const networkLabel = PRIVATE_NETWORKS[network].label;
  const checks: UiCheck[] = [];
  const put = (c: UiCheck) => {
    const i = checks.findIndex((x) => x.id === c.id);
    if (i >= 0) checks[i] = c;
    else checks.push(c);
    onUpdate([...checks]);
  };
  const done = (probe: ProbeResult | null, tailscale: TailscaleStatus | null): CheckOutcome => ({
    checks,
    blocked: checks.some((c) => c.level === "error"),
    probe,
    tailscale,
  });

  put(
    deps.keychainOk
      ? { id: "device", label: "This computer", level: "ok", detail: "Secure storage is available." }
      : {
          id: "device",
          label: "This computer",
          level: "warn",
          detail: "Couldn't open the system keychain.",
          hint: "Vault Finance will work, but you'll have to sign in each time you open it.",
        },
  );

  // Tailscale status and the server probe run side by side; the Tailscale row
  // is finalised once we know whether the server answered.
  let tailscale: TailscaleStatus | null = null;
  const tsPromise = canReadNetwork
    ? (put({ id: "tailscale", label: networkLabel, level: "pending" }),
      platform.tailscaleStatus!().catch(() => null))
    : Promise.resolve(null);
  put({ id: "server", label: "Server connection", level: "pending", detail: hostPort(primary).host });
  const [ts, picked] = await Promise.all([tsPromise, pickAddress(platform, primary, alternate)]);
  const { address, probe } = picked;
  tailscale = ts;
  if (probe.reachable) deps.onRoute?.(address);

  const vpnAddress = alternate && looksLikeTailnet(alternate) ? alternate : primary;
  if (tailscale) put(tailscaleCheck(tailscale, vpnAddress, !probe.reachable, networkLabel));
  else if (canReadNetwork) checks.splice(checks.findIndex((c) => c.id === "tailscale"), 1);

  if (!probe.reachable) {
    const failure = describeProbeFailure(probe, primary, network);
    put({
      id: "server",
      label: "Server connection",
      level: "error",
      ...failure,
      ...(alternate
        ? {
            detail: `No answer from either address (${hostPort(primary).host}, ${hostPort(alternate).host}).`,
            hint: `Make sure the server machine is switched on, and that you're at home${networkName(network) ? ` or connected to ${networkName(network)}` : ""}.`,
          }
        : {}),
      action: "change-server",
    });
    return done(probe, tailscale);
  }
  put({ id: "server", label: "Server connection", level: "ok", detail: `Reachable at ${hostPort(address).host}.` });

  // Identity: a pinned certificate that no longer matches is a hard stop.
  const pin = await platform.getPin(address).catch(() => null);
  if (platform.kind === "tauri" && pin && probe.fingerprint && pin.toLowerCase() !== probe.fingerprint.toLowerCase()) {
    put({
      id: "identity",
      label: "Server identity",
      level: "error",
      detail: "The server's security certificate has changed since you last connected.",
      hint: "If you reinstalled the server or replaced its certificate, choose Change server to verify it again. If not, don't continue — something may be intercepting the connection.",
      action: "change-server",
    });
    return done(probe, tailscale);
  }
  if (pin || probe.trustedByOs) {
    put({ id: "identity", label: "Server identity", level: "ok", detail: probe.trustedByOs ? "Valid certificate." : "Matches the certificate you verified." });
  }

  // Version compatibility.
  put({ id: "version", label: "App and server versions", level: "pending" });
  try {
    const v = await client.version();
    if (compareSemver(deps.appVersion, v.minClientVersion) < 0) {
      put({
        id: "version",
        label: "App and server versions",
        level: "error",
        detail: `The server needs app version ${v.minClientVersion} or newer; this is ${deps.appVersion}.`,
        hint: "Update Vault Finance, then open it again.",
        action: "update-app",
      });
      return done(probe, tailscale);
    }
    put(
      compareSemver(v.apiVersion, deps.appVersion) < 0
        ? {
            id: "version",
            label: "App and server versions",
            level: "warn",
            detail: `The server (${v.apiVersion}) is older than this app (${deps.appVersion}).`,
            hint: "Newer features may not work until the server is updated (Settings → Server update).",
          }
        : { id: "version", label: "App and server versions", level: "ok", detail: `App ${deps.appVersion} · server ${v.apiVersion}.` },
    );
  } catch (err) {
    put({
      id: "version",
      label: "App and server versions",
      level: "error",
      detail: err instanceof ApiRequestError ? err.message : "The server didn't answer the version check.",
      hint: "If you just changed the server, choose Change server to connect again.",
      action: "change-server",
    });
    return done(probe, tailscale);
  }

  // The server's own components. Older servers don't have /status — skip quietly.
  try {
    const s = await client.serverStatus();
    s.checks.forEach((c) => put(fromServer(c)));
  } catch (err) {
    if (!(err instanceof ApiRequestError && err.status === 404)) {
      put({ id: "server-health", label: "Server health", level: "warn", detail: "The server didn't report its health." });
    }
  }

  if (deps.hasSession) {
    try {
      const d = await client.statusDetails();
      d.checks.forEach((c) => put(fromServer(c)));
    } catch {
      // Signed out, expired, or an older server — sign-in will sort it out.
    }
  }

  return done(probe, tailscale);
}
