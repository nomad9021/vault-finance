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
  void (next
    ? platformRef.setSecret(TOKENS_KEY, JSON.stringify(next))
    : platformRef.deleteSecret(TOKENS_KEY));
}

export const useApp = create<AppState>((set, get) => ({
  // Filled in by bootstrap() before the first render; the casts keep the
  // store type honest for every consumer after boot.
  platform: null as unknown as HostPlatform,
  client: null as unknown as ApiClient,
  screen: { name: "boot" },
  serverAddress: null,
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
    persistTokens(null);
    await get().platform.deleteValue(ADDRESS_KEY);
    set({ user: null, serverAddress: null, screen: { name: "connect" } });
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

/** Load persisted state and decide the first screen. Called once before render. */
export async function bootstrap(): Promise<void> {
  const platform = await getPlatform();
  platformRef = platform;
  useApp.setState({ platform });

  const storedTheme = await platform.loadValue(THEME_KEY);
  const theme: Theme = isTheme(storedTheme) ? storedTheme : "automatic";
  applyTheme(theme);
  useApp.setState({ theme });

  const storedTokens = await platform.getSecret(TOKENS_KEY);
  if (storedTokens) {
    try {
      tokens = JSON.parse(storedTokens) as TokenPair;
    } catch {
      tokens = null;
    }
  }

  const address = await platform.loadValue(ADDRESS_KEY);
  if (!address) {
    useApp.setState({ screen: { name: "connect" } });
    return;
  }

  useApp.setState({ serverAddress: address });
  rebuildClient((p) => useApp.setState(p), useApp.getState, address);
  await useApp.getState().routeForServer();
}
