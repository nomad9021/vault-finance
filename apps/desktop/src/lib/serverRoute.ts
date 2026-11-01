import type { FetchLike, StreamFetchLike } from "@vault/shared";
import type { HostPlatform, ProbeResult } from "../platform/index.js";

/**
 * One server, up to two addresses: typically its home address and its VPN
 * address. The first address stays the server's identity (saved sessions and
 * device keys are stored under it); only the transport moves between the two.
 */
export interface ServerRoute {
  primary: string;
  alternate: string | null;
  /** The address requests go to right now. */
  active: string;
}

export const alternateAddressKey = (primary: string) => `alternate-address:${primary}`;

export function newRoute(primary: string, alternate: string | null = null): ServerRoute {
  return { primary, alternate, active: primary };
}

/** Send a request built for the primary address to the active one. */
export function rewriteUrl(route: ServerRoute, url: string): string {
  return url.startsWith(route.primary) ? route.active + url.slice(route.primary.length) : url;
}

/**
 * Probe both addresses together and take the first that answers, so being home
 * never means waiting for a VPN address to time out. When neither answers, the
 * result describes the primary, for the error message.
 */
export async function pickAddress(
  platform: Pick<HostPlatform, "probeServer">,
  primary: string,
  alternate: string | null | undefined,
): Promise<{ address: string; probe: ProbeResult }> {
  const primaryProbe = platform.probeServer(primary);
  if (!alternate) return { address: primary, probe: await primaryProbe };

  const attempt = (address: string, probing: Promise<ProbeResult>) =>
    probing.then((probe) => {
      if (!probe.reachable) throw new Error("no answer");
      return { address, probe };
    });
  try {
    return await Promise.any([
      attempt(primary, primaryProbe),
      attempt(alternate, platform.probeServer(alternate)),
    ]);
  } catch {
    return { address: primary, probe: await primaryProbe };
  }
}

/** Probe again and update the route; simultaneous callers share one attempt. */
export function makeReselect(platform: Pick<HostPlatform, "probeServer">, getRoute: () => ServerRoute) {
  let running: Promise<void> | null = null;
  return (): Promise<void> => {
    running ??= (async () => {
      const route = getRoute();
      const { address, probe } = await pickAddress(platform, route.primary, route.alternate);
      if (probe.reachable && getRoute() === route) route.active = address;
    })().finally(() => {
      running = null;
    });
    return running;
  };
}

/**
 * Route API traffic. When a request can't get through, look for the address
 * that does answer (the laptop left home, or the VPN came on). Only reads are
 * retried: a failed write may still have reached the server, so it's reported
 * as usual and the next attempt uses the new address.
 */
export function routedFetch(fetchImpl: FetchLike, getRoute: () => ServerRoute, reselect: () => Promise<void>): FetchLike {
  return async (url, init) => {
    const route = getRoute();
    const tried = route.active;
    try {
      return await fetchImpl(rewriteUrl(route, url), init);
    } catch (err) {
      if (!route.alternate) throw err;
      await reselect();
      if (route.active === tried || (init.method !== "GET" && init.method !== "HEAD")) throw err;
      return fetchImpl(rewriteUrl(route, url), init);
    }
  };
}

export function routedStreamFetch(streamFetchImpl: StreamFetchLike, getRoute: () => ServerRoute): StreamFetchLike {
  return (url, init, onChunk, signal) => streamFetchImpl(rewriteUrl(getRoute(), url), init, onChunk, signal);
}

export type AlternateTrust =
  /** Valid for the OS, or no pinning on this platform: nothing to store. */
  | { kind: "os" }
  /** Same certificate as the server we already trust: pin it. */
  | { kind: "same"; fingerprint: string }
  /** We have no pin to compare with, so the person must confirm it. */
  | { kind: "confirm"; fingerprint: string }
  /** A different certificate from the server we trust: not this server. */
  | { kind: "mismatch" };

export function alternateTrust(
  platformKind: HostPlatform["kind"],
  primaryPin: string | null,
  probe: ProbeResult,
): AlternateTrust {
  if (platformKind !== "tauri" || probe.trustedByOs || !probe.fingerprint) return { kind: "os" };
  if (!primaryPin) return { kind: "confirm", fingerprint: probe.fingerprint };
  return primaryPin.toLowerCase() === probe.fingerprint.toLowerCase()
    ? { kind: "same", fingerprint: probe.fingerprint }
    : { kind: "mismatch" };
}
