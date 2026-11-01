/**
 * How this computer reaches the server when away from home. A preference of
 * this device, not household data. Only Tailscale's own client can be read and
 * switched from the app (Headscale uses that client too); for anything else the
 * app stays out of the way, and the server check alone says whether it's up.
 */
export type PrivateNetworkId =
  | "tailscale"
  | "headscale"
  | "netbird"
  | "twingate"
  | "zerotier"
  | "wireguard"
  | "other"
  | "none";

interface PrivateNetwork {
  label: string;
  /** Where to get its client; https only, like every link the app opens. */
  url?: string;
}

export const PRIVATE_NETWORKS: Record<PrivateNetworkId, PrivateNetwork> = {
  tailscale: { label: "Tailscale", url: "https://tailscale.com/download" },
  headscale: { label: "Headscale", url: "https://headscale.net" },
  netbird: { label: "NetBird", url: "https://netbird.io" },
  twingate: { label: "Twingate", url: "https://www.twingate.com/download" },
  zerotier: { label: "ZeroTier", url: "https://www.zerotier.com/download/" },
  wireguard: { label: "WireGuard", url: "https://www.wireguard.com/install/" },
  other: { label: "Another VPN" },
  none: { label: "None, only on my home network" },
};

const KEY = "private-network";

export function getPrivateNetwork(): PrivateNetworkId {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && saved in PRIVATE_NETWORKS) return saved as PrivateNetworkId;
  } catch {
    // Storage unavailable: fall through to the default.
  }
  return "tailscale";
}

export function setPrivateNetwork(id: PrivateNetworkId): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // Not remembered, but still applies for this session's screens.
  }
}

/** The app can read and switch this one through the Tailscale client. */
export function usesTailscaleClient(id: PrivateNetworkId): boolean {
  return id === "tailscale" || id === "headscale";
}

/** How to name it in a sentence, or null when there's no private network. */
export function networkName(id: PrivateNetworkId): string | null {
  if (id === "none") return null;
  return id === "other" ? "your VPN" : PRIVATE_NETWORKS[id].label;
}
