import {
  ApiClient,
  ApiRequestError,
  type ConnectionStatus,
  type TokenPair,
  type User,
} from "@vault/shared";
import { applyTheme, isTheme, type Theme } from "@vault/design-tokens";
import { create } from "zustand";
import {
  getPlatform,
  type BiometricResult,
  type BiometricStatus,
  type HostPlatform,
  type ProbeResult,
} from "../platform/index.js";

export const APP_VERSION = "0.1.3";

export type Screen =
  | { name: "boot" }
  | { name: "connect"; error?: string }
  | { name: "trust"; address: string; probe: ProbeResult }
  | { name: "setup" }
  | { name: "login" }
  | { name: "shell" };

/** Desktop self-update, shared by the header button and the Settings card. */
export type AppUpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "none" }
  | { phase: "available"; version: string }
  | { phase: "installing"; version: string; progress: number }
  | { phase: "error"; message: string; version?: string };

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
  /** The household's own name ("The Carters"); null until the owner sets one. */
  householdName: string | null;
  /**
   * A saved session exists but this device requires a biometric check before
   * showing it. The login screen renders in "locked" mode while this is set.
   */
  lockedUser: User | null;
  /** This device's biometric hardware, checked once at boot. */
  biometric: BiometricStatus | null;
  /** Users enrolled for biometric sign-in on this device, for the current server. */
  biometricUserIds: string[];
  appUpdate: AppUpdateState;

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
  setHouseholdName(name: string | null): void;
  /** Enroll the signed-in user: OS prompt, then a server-issued device key into the keychain. */
  enableBiometric(): Promise<BiometricResult>;
  /** Forget this device's key locally and revoke it on the server. */
  disableBiometric(): Promise<void>;
  /** OS prompt, then resume the locked session or sign in with the device key. */
  unlockWithBiometric(userId: string): Promise<BiometricResult>;
  checkAppUpdate(opts?: { silent?: boolean }): Promise<void>;
  installAppUpdate(): Promise<void>;
}

const TOKENS_KEY = "refresh-tokens";
const ADDRESS_KEY = "server-address";
const THEME_KEY = "theme";
/** Non-secret list of enrolled user ids, so the login screen needn't touch the keychain. */
const biometricUsersKey = (address: string) => `biometric-users:${address}`;
/** Keychain entry holding `{ id, key }` for one user's device key on one server. */
export const deviceKeySecret = (address: string, userId: string) =>
  `device-key:${address}:${userId}`;

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
  theme: "light",
  aiVisible: false,
  householdName: null,
  lockedUser: null,
  biometric: null,
  biometricUserIds: [],
  appUpdate: { phase: "idle" },

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
      await loadBiometricUsers(set, get);
      if (tokens) {
        try {
          const user = await client.me();
          if (get().biometricUserIds.includes(user.id)) {
            // Keep the session, but make the user prove it's them first.
            set({ user: null, lockedUser: user, screen: { name: "login" } });
            return;
          }
          get().signedIn(user);
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
    set({ user, lockedUser: null, screen: { name: "shell" } });
    void get().refreshAiEnabled();
    get()
      .client.household()
      .then((h) => set({ householdName: h.name }))
      .catch(() => {});
  },

  setHouseholdName(name) {
    set({ householdName: name });
  },

  async enableBiometric() {
    const { platform, client, serverAddress, user } = get();
    if (!serverAddress || !user) return { ok: false, reason: "unavailable" };
    const status = await platform.biometricStatus();
    set({ biometric: status });
    if (!status.available) {
      return { ok: false, reason: "unavailable", ...(status.reason ? { message: status.reason } : {}) };
    }

    const check = await platform.biometricAuthenticate(`Turn on ${status.label} for Vault Finance`);
    if (!check.ok) return check;

    const created = await client.createDeviceKey({
      deviceName: platform.deviceName,
      platform: platform.platformName,
    });
    try {
      await platform.setSecret(deviceKeySecret(serverAddress, user.id), JSON.stringify(created));
    } catch {
      // No keychain, no biometric sign-in — don't leave a live key behind.
      await client.revokeDeviceKey(created.id).catch(() => {});
      return {
        ok: false,
        reason: "unavailable",
        message: "Couldn't save to this computer's keychain, so biometric sign-in can't be turned on.",
      };
    }
    await saveBiometricUsers(set, get, [...new Set([...get().biometricUserIds, user.id])]);
    return { ok: true };
  },

  async disableBiometric() {
    const { platform, client, serverAddress, user } = get();
    if (!serverAddress || !user) return;
    const secretName = deviceKeySecret(serverAddress, user.id);
    const stored = await platform.getSecret(secretName).catch(() => null);
    const id = parseDeviceKey(stored)?.id;
    if (id) await client.revokeDeviceKey(id).catch(() => {});
    await platform.deleteSecret(secretName).catch(() => {});
    await saveBiometricUsers(set, get, get().biometricUserIds.filter((u) => u !== user.id));
  },

  async unlockWithBiometric(userId) {
    const { platform, client, serverAddress, lockedUser } = get();
    if (!serverAddress) return { ok: false, reason: "unavailable" };
    const label = get().biometric?.label ?? "biometrics";
    const check = await platform.biometricAuthenticate("Sign in to Vault Finance");
    if (!check.ok) return check;

    // Same person as the saved session: just let them back in.
    if (lockedUser?.id === userId && tokens) {
      get().signedIn(lockedUser);
      return { ok: true };
    }

    const stored = parseDeviceKey(
      await platform.getSecret(deviceKeySecret(serverAddress, userId)).catch(() => null),
    );
    const forget = () =>
      saveBiometricUsers(set, get, get().biometricUserIds.filter((u) => u !== userId));
    if (!stored) {
      await forget();
      return {
        ok: false,
        reason: "unavailable",
        message: `This device's ${label} key is missing. Sign in with your password, then turn it back on in Settings.`,
      };
    }
    // A different person's session was waiting — end it before switching.
    if (tokens) await client.logout();
    try {
      const result = await client.loginWithDeviceKey({
        key: stored.key,
        deviceName: platform.deviceName,
        platform: platform.platformName,
      });
      get().signedIn(result.user);
      return { ok: true };
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) {
        await platform.deleteSecret(deviceKeySecret(serverAddress, userId)).catch(() => {});
        await forget();
        return {
          ok: false,
          reason: "unavailable",
          message: `${label} sign-in was turned off for this device. Sign in with your password.`,
        };
      }
      return {
        ok: false,
        reason: "unavailable",
        message:
          err instanceof ApiRequestError && err.code === "RATE_LIMITED"
            ? "Too many attempts — wait a few minutes and try again."
            : "Lost the connection to the server.",
      };
    }
  },

  async checkAppUpdate({ silent = false } = {}) {
    const { platform, appUpdate } = get();
    if (platform.kind !== "tauri") return;
    if (appUpdate.phase === "checking" || appUpdate.phase === "installing") return;
    if (!silent) set({ appUpdate: { phase: "checking" } });
    try {
      const update = await platform.checkForUpdate();
      set({ appUpdate: update ? { phase: "available", version: update.version } : { phase: "none" } });
    } catch (err) {
      // Background checks stay quiet (offline laptops shouldn't nag); a check
      // the user asked for reports why it failed.
      set({
        appUpdate: silent
          ? appUpdate
          : {
              phase: "error",
              message: err instanceof Error ? err.message : "Couldn't reach the update server.",
            },
      });
    }
  },

  async installAppUpdate() {
    const { platform, appUpdate } = get();
    if (appUpdate.phase !== "available" && !(appUpdate.phase === "error" && appUpdate.version)) {
      return;
    }
    const version = appUpdate.version!;
    set({ appUpdate: { phase: "installing", version, progress: 0 } });
    try {
      await platform.installUpdateAndRestart((progress) =>
        set({ appUpdate: { phase: "installing", version, progress } }),
      );
    } catch (err) {
      set({
        appUpdate: {
          phase: "error",
          version,
          message: err instanceof Error ? err.message : String(err || "The update failed to install."),
        },
      });
    }
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
    set({ user: null, lockedUser: null, aiVisible: false, screen: { name: "login" } });
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

function parseDeviceKey(raw: string | null): { id: string; key: string } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { id?: unknown; key?: unknown };
    return typeof v.id === "string" && typeof v.key === "string" ? { id: v.id, key: v.key } : null;
  } catch {
    return null;
  }
}

async function loadBiometricUsers(
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
) {
  const { platform, serverAddress } = get();
  let ids: string[] = [];
  if (serverAddress) {
    try {
      const raw = await platform.loadValue(biometricUsersKey(serverAddress));
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === "string");
    } catch (err) {
      console.error("loading biometric enrollments failed", err);
    }
  }
  set({ biometricUserIds: ids });
}

async function saveBiometricUsers(
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
  ids: string[],
) {
  set({ biometricUserIds: ids });
  const { platform, serverAddress } = get();
  if (serverAddress) await platform.saveValue(biometricUsersKey(serverAddress), JSON.stringify(ids));
}

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
      set({ user: null, lockedUser: null, screen: { name: "login" } });
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

const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** Quietly look for a new desktop release shortly after launch, then every 6 hours. */
function startUpdateChecks() {
  const check = () => void useApp.getState().checkAppUpdate({ silent: true });
  setTimeout(check, 10_000);
  setInterval(check, UPDATE_CHECK_EVERY_MS);
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
  void platform.biometricStatus().then((biometric) => useApp.setState({ biometric }));
  startUpdateChecks();

  try {
    const storedTheme = await platform.loadValue(THEME_KEY);
    // Default to the light "premium" look (matches the design references); users
    // can switch to automatic/dark/oled/contrast in Settings.
    const theme: Theme = isTheme(storedTheme) ? storedTheme : "light";
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
