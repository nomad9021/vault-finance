import { ApiRequestError, type ApiClient } from "@vault/shared";
import { describe, expect, it } from "vitest";
import type { HostPlatform, ProbeResult, TailscaleStatus } from "../platform/index.js";
import { describeProbeFailure, looksLikeTailnet, runChecks, tailscaleCheck } from "./startupChecks.js";

const ts = (over: Partial<TailscaleStatus> = {}): TailscaleStatus => ({
  installed: true,
  state: "Running",
  ips: ["100.70.1.2"],
  health: [],
  ...over,
});

function fakes(opts: {
  probe?: ProbeResult;
  pin?: string | null;
  tailscale?: TailscaleStatus;
  minClient?: string;
  apiVersion?: string;
  serverStatus?: () => Promise<unknown>;
}) {
  const platform = {
    kind: "tauri",
    probeServer: async () => opts.probe ?? { reachable: true, fingerprint: "ab", trustedByOs: false },
    getPin: async () => (opts.pin === undefined ? "ab" : opts.pin),
    ...(opts.tailscale ? { tailscaleStatus: async () => opts.tailscale! } : {}),
  } as unknown as HostPlatform;
  const client = {
    version: async () => ({ apiVersion: opts.apiVersion ?? "0.2.0", minClientVersion: opts.minClient ?? "0.1.0" }),
    serverStatus:
      opts.serverStatus ??
      (async () => ({
        apiVersion: "0.2.0",
        startedAt: new Date().toISOString(),
        checks: [{ id: "database", label: "Database", level: "ok" }],
      })),
    statusDetails: async () => ({ checks: [{ id: "ai", label: "AI assistant", level: "off" }] }),
  } as unknown as ApiClient;
  return { platform, client };
}

const deps = (f: ReturnType<typeof fakes>, address = "https://vault.lan:8443") => ({
  ...f,
  address,
  appVersion: "0.2.0",
  keychainOk: true,
  hasSession: true,
});

describe("looksLikeTailnet", () => {
  it("recognises Tailscale addresses and names", () => {
    expect(looksLikeTailnet("https://100.101.102.103:8443")).toBe(true);
    expect(looksLikeTailnet("https://server.example.ts.net:8443")).toBe(true);
    expect(looksLikeTailnet("https://[fd7a:115c:a1e0::1]:8443")).toBe(true);
    expect(looksLikeTailnet("https://100.12.0.1:8443")).toBe(false); // outside 100.64/10
    expect(looksLikeTailnet("https://192.168.1.10:8443")).toBe(false);
  });
});

describe("describeProbeFailure", () => {
  const at = "https://vault.lan:8443";
  it.each([
    ["error sending request: dns error: failed to lookup address information", /couldn't find/i],
    ["error sending request: tcp connect error: Connection refused (os error 111)", /isn't running on port 8443/],
    ["error sending request: operation timed out", /no answer/i],
    ["invalid peer certificate: BadSignature", /secure connection/i],
  ])("explains %s", (error, expected) => {
    expect(describeProbeFailure({ reachable: false, error }, at).detail).toMatch(expected);
  });
  it("spots a non-Vault server by its HTTP status", () => {
    expect(describeProbeFailure({ reachable: false, httpStatus: 404 }, at).hint).toMatch(/8443/);
  });
});

describe("tailscaleCheck", () => {
  it("blocks when a Tailscale-only server is unreachable because Tailscale is off", () => {
    const c = tailscaleCheck(ts({ state: "Stopped", ips: [] }), "https://100.70.0.1:8443", true);
    expect(c).toMatchObject({ level: "error", action: "tailscale-up" });
  });
  it("is just 'off' when not needed and the server is fine", () => {
    expect(tailscaleCheck(ts({ state: "Stopped" }), "https://192.168.1.10:8443", false).level).toBe("off");
  });
  it("suggests installing when the server is on a tailnet", () => {
    const c = tailscaleCheck({ installed: false, state: "NotInstalled", ips: [], health: [] }, "https://x.ts.net", false);
    expect(c).toMatchObject({ level: "error", action: "tailscale-install" });
  });
});

describe("runChecks", () => {
  it("passes a healthy setup and includes the server's own checks", async () => {
    const out = await runChecks(deps(fakes({ tailscale: ts() })), () => {});
    expect(out.blocked).toBe(false);
    expect(out.checks.map((c) => [c.id, c.level])).toEqual([
      ["device", "ok"],
      ["tailscale", "ok"],
      ["server", "ok"],
      ["identity", "ok"],
      ["version", "ok"],
      ["database", "ok"],
      ["ai", "off"],
    ]);
  });

  it("stops at an unreachable server and blames Tailscale when it's off", async () => {
    const f = fakes({
      probe: { reachable: false, error: "operation timed out" },
      tailscale: ts({ state: "Stopped", ips: [] }),
    });
    const out = await runChecks(deps(f), () => {});
    expect(out.blocked).toBe(true);
    expect(out.checks.find((c) => c.id === "tailscale")?.level).toBe("error");
    expect(out.checks.find((c) => c.id === "server")?.level).toBe("error");
    expect(out.checks.some((c) => c.id === "version")).toBe(false);
  });

  it("refuses a server whose certificate changed", async () => {
    const out = await runChecks(deps(fakes({ pin: "aa", probe: { reachable: true, fingerprint: "bb" } })), () => {});
    expect(out.checks.find((c) => c.id === "identity")).toMatchObject({ level: "error", action: "change-server" });
  });

  it("blocks an app that's too old for the server", async () => {
    const out = await runChecks(deps(fakes({ minClient: "0.3.0" })), () => {});
    expect(out.checks.find((c) => c.id === "version")).toMatchObject({ level: "error", action: "update-app" });
  });

  it("warns, without blocking, when the server is older than the app", async () => {
    const out = await runChecks(deps(fakes({ apiVersion: "0.1.0", minClient: "0.1.0" })), () => {});
    expect(out.blocked).toBe(false);
    expect(out.checks.find((c) => c.id === "version")?.level).toBe("warn");
  });

  it("skips server health quietly on an older server without /status", async () => {
    const f = fakes({
      serverStatus: async () => {
        throw new ApiRequestError("NOT_FOUND", 404, "Not found");
      },
    });
    const out = await runChecks(deps(f), () => {});
    expect(out.checks.some((c) => c.id === "server-health")).toBe(false);
    expect(out.blocked).toBe(false);
  });

  it("reports progress row by row", async () => {
    const seen: number[] = [];
    await runChecks(deps(fakes({})), (c) => seen.push(c.length));
    expect(seen[0]).toBe(1);
    expect(Math.max(...seen)).toBeGreaterThan(3);
  });
});
