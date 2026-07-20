import {
  ApiClient,
  type ConnectionStatus,
  type TokenPair,
  type User,
} from "@vault/shared";
import { applyTheme, isTheme, type Theme } from "@vault/design-tokens";
import { create } from "zustand";
import { getPlatform, type HostPlatform, type ProbeResult } from "../platform/index.js";

export const APP_VERSION = "0.1.0";

export type Screen =
  | { name: "boot" }
  | { name: "connect"; error?: string }
  | { name: "trust"; address: string; probe: ProbeResult }
  | { name: "setup" }
  | { name: "login" }
  | { name: "shell" };

interface AppState {
  platform: HostPlatform;
  client: ApiClient;
  screen: Screen;
  serverAddress: string | null;
  /** The server to return to if the user backs out of the connect flow; null
   *  on first-ever launch (nothing to go back to). */
  priorAddress: string | null;
  connection: ConnectionStatus;
  user: User | null;
  theme: Theme;
  /** Whether AI is on AND configured — gates every AI surface (off by default). */
  aiVisible: boolean;

  /** Probe an address; route to trust confirmation or straight on. */
  connectTo(address: string): Promise<void>;
  /** User confirmed the fingerprint on the trust screen. */
  confirmTrust(): Promise<void>;
  /** Decide setup/login/shell for the active server. */
  routeForServer(): Promise<void>;
  signedIn(user: User): void;
  signOut(): Promise<void>;
  setTheme(theme: Theme): Promise<void>;
  changeServer(): Promise<void>;
  /** Back out of the connect screen, restoring the prior server. No-op (and no
   *  button shown) when there's no prior server to return to. */
  cancelConnect(): Promise<void>;
  /** Decline a trust prompt: return to the connect screen without pinning. */
  declineTrust(): void;
  /** Re-check AI status and update aiVisible (called after login and after saving AI settings). */
  refreshAiEnabled(): Promise<void>;
}

const TOKENS_KEY = "refresh-tokens";
const ADDRESS_KEY = "server-address";
const THEME_KEY = "theme";

// Tokens live outside React state: the ApiClient reads them synchronously and
// they must never trigger re-renders. Persisted to the platform secret store.
let tokens: TokenPair | null = null;
let platformRef: HostPlatform | null = null;

function persistTokens(next: TokenPair | null) {
  tokens = next;
  if (!platformRef) return;
  // Best-effort: the in-memory `tokens` above already drives this session, so
  // a locked/unavailable OS keychain just means the session won't survive a
  // restart — it must never throw into the caller.
  void (next
    ? platformRef.setSecret(TOKENS_KEY, JSON.stringify(next))
    : platformRef.deleteSecret(TOKENS_KEY)
  ).catch((err) => console.error("keychain write failed; session is memory-only", err));
}

export const useApp = create<AppState>((set, get) => ({
  // Filled in by bootstrap() before the first render; the casts keep the
  // store type honest for every consumer after boot.
  platform: null as unknown as HostPlatform,
  client: null as unknown as ApiClient,
  screen: { name: "boot" },
  serverAddress: null,
  priorAddress: null,
  connection: "online",
  user: null,
  theme: "automatic",
  aiVisible: false,

  async connectTo(rawAddress) {
    const address = normalizeAddress(rawAddress);
    if (!address) {
      set({ screen: { name: "connect", error: "Enter a server address, e.g. https://192.168.1.10:8443" } });
      return;
    }
    const { platform } = get();
    const probe = await platform.probeServer(address);
    if (!probe.reachable) {
      set({
        screen: {
          name: "connect",
          error: "No Vault Finance server answered at that address. Check the address and that the server is running.",
        },
      });
      return;
    }

    const alreadyPinned = await platform.getPin(address);
    const needsTrust =
      platform.kind === "tauri" && !probe.trustedByOs && !alreadyPinned;

    set({ serverAddress: address });
    await platform.saveValue(ADDRESS_KEY, address);
    rebuildClient(set, get, address);

    if (needsTrust) {
      set({ screen: { name: "trust", address, probe } });
    } else {
      await get().routeForServer();
    }
  },

  async confirmTrust() {
    const { screen, platform } = get();
    if (screen.name !== "trust") return;
    await platform.trustServer(screen.address, screen.probe.fingerprint ?? null);
    await get().routeForServer();
  },

  async routeForServer() {
    const { client } = get();
    try {
      const { needsSetup } = await client.setupStatus();
      if (needsSetup) {
        set({ screen: { name: "setup" } });
        return;
      }
      if (tokens) {
        try {
          const user = await client.me();
          set({ user, screen: { name: "shell" } });
          void get().refreshAiEnabled();
          return;
        } catch {
          persistTokens(null); // stale/revoked session — fall through to login
        }
      }
      set({ screen: { name: "login" } });
    } catch {
      set({
        screen: {
          name: "connect",
          error: "Reached the address, but it didn't answer like a Vault Finance server.",
        },
      });
    }
  },

  signedIn(user) {
    set({ user, screen: { name: "shell" } });
    void get().refreshAiEnabled();
  },

  async refreshAiEnabled() {
    try {
      const status = await get().client.aiStatus();
      set({ aiVisible: status.enabled && status.configured });
    } catch {
      set({ aiVisible: false });
    }
  },

  async signOut() {
    await get().client.logout();
    set({ user: null, aiVisible: false, screen: { name: "login" } });
  },

  async setTheme(theme) {
    applyTheme(theme);
    set({ theme });
    await get().platform.saveValue(THEME_KEY, theme);
  },

  /** Settings → connect to a different server. Keeps the pin; drops the session. */
  async changeServer() {
    // Non-destructive: keep the current server/session so the user can cancel
    // back out. The old server is only replaced once a new connection actually
    // succeeds (connectTo persists the new address). Remember where we were so
    // the connect screen can offer a way back.
    set({ priorAddress: get().serverAddress, screen: { name: "connect" } });
  },

  async cancelConnect() {
    const prior = get().priorAddress;
    if (!prior) return;
    set({ priorAddress: null, serverAddress: prior });
    await get().platform.saveValue(ADDRESS_KEY, prior);
    rebuildClient(set, get, prior);
    await get().routeForServer();
  },

  declineTrust() {
    set({ screen: { name: "connect" } });
  },
}));

function normalizeAddress(raw: string): string | null {
  let s = raw.trim().replace(/\/+$/, "");
  if (!s) return null;
  if (!/^https?:\/\//.test(s)) s = `https://${s}`;
  try {
    return new URL(s).origin;
  } catch {
    return null;
  }
}

function rebuildClient(
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
  address: string,
) {
  const { platform } = get();
  const client = new ApiClient({
    baseUrl: address,
    clientVersion: APP_VERSION,
    fetchImpl: platform.fetchImpl,
    streamFetchImpl: platform.streamFetchImpl,
    getTokens: () => tokens,
    setTokens: persistTokens,
    onAuthLost: () => {
      set({ user: null, screen: { name: "login" } });
    },
    onConnectionChange: (connection) => set({ connection }),
  });
  set({ client });
}

/**
 * Reject if `p` doesn't settle within `ms`. Used to guard boot-critical calls
 * that talk to the OS (the keychain in particular): on Linux a locked or
 * unavailable Secret Service can block indefinitely, and the app must still
 * boot — a missing session just means "logged out", never a frozen spinner.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/** Load persisted state and decide the first screen. Called once before render. */
export async function bootstrap(): Promise<void> {
  let platform: HostPlatform;
  try {
    platform = await getPlatform();
  } catch (err) {
    console.error("platform init failed", err);
    useApp.setState({ screen: { name: "connect" } });
    return;
  }
  platformRef = platform;
  useApp.setState({ platform });

  try {
    const storedTheme = await platform.loadValue(THEME_KEY);
    const theme: Theme = isTheme(storedTheme) ? storedTheme : "automatic";
    applyTheme(theme);
    useApp.setState({ theme });
  } catch (err) {
    console.error("loading theme failed; using default", err);
  }

  // The OS keychain is best-effort: if it's locked, missing, or slow (common
  // on headless/autologin Linux), we boot logged-out rather than hang.
  try {
    const storedTokens = await withTimeout(
      platform.getSecret(TOKENS_KEY),
      3000,
      "keychain read",
    );
    if (storedTokens) tokens = JSON.parse(storedTokens) as TokenPair;
  } catch (err) {
    console.error("keychain unavailable; continuing without a saved session", err);
    tokens = null;
  }

  let address: string | null = null;
  try {
    address = await platform.loadValue(ADDRESS_KEY);
  } catch (err) {
    console.error("loading server address failed", err);
  }
  if (!address) {
    useApp.setState({ screen: { name: "connect" } });
    return;
  }

  useApp.setState({ serverAddress: address });
  rebuildClient((p) => useApp.setState(p), useApp.getState, address);
  try {
    await useApp.getState().routeForServer();
  } catch (err) {
    console.error("routing to server failed", err);
    useApp.setState({ screen: { name: "connect", error: "Couldn't reach the saved server. Check the address below." } });
  }
}
