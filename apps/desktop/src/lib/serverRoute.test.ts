import type { FetchLike } from "@vault/shared";
import { describe, expect, it } from "vitest";
import type { ProbeResult } from "../platform/index.js";
import { alternateTrust, makeReselect, newRoute, pickAddress, rewriteUrl, routedFetch } from "./serverRoute.js";

const HOME = "https://192.168.1.10:8443";
const VPN = "https://100.70.0.1:8443";
const ok: ProbeResult = { reachable: true };
const down: ProbeResult = { reachable: false, error: "operation timed out" };
const prober = (answers: Record<string, ProbeResult>) => ({ probeServer: async (a: string) => answers[a]! });

describe("rewriteUrl", () => {
  it("moves a request to the active address and keeps the path", () => {
    const route = { ...newRoute(HOME, VPN), active: VPN };
    expect(rewriteUrl(route, `${HOME}/api/v1/members?x=1`)).toBe(`${VPN}/api/v1/members?x=1`);
  });
  it("never rewrites anything aimed elsewhere", () => {
    const route = { ...newRoute(HOME, VPN), active: VPN };
    expect(rewriteUrl(route, "https://other.example/api")).toBe("https://other.example/api");
  });
});

describe("pickAddress", () => {
  it("uses whichever address answers", async () => {
    expect((await pickAddress(prober({ [HOME]: down, [VPN]: ok }), HOME, VPN)).address).toBe(VPN);
    expect((await pickAddress(prober({ [HOME]: ok, [VPN]: down }), HOME, VPN)).address).toBe(HOME);
  });
  it("doesn't wait for a slow address when the other has answered", async () => {
    const platform = {
      probeServer: (a: string) => (a === HOME ? Promise.resolve(ok) : new Promise<ProbeResult>(() => {})),
    };
    expect((await pickAddress(platform, HOME, VPN)).address).toBe(HOME);
  });
  it("reports the first address when neither answers", async () => {
    const out = await pickAddress(prober({ [HOME]: down, [VPN]: down }), HOME, VPN);
    expect(out).toEqual({ address: HOME, probe: down });
  });
  it("works with one address", async () => {
    expect((await pickAddress(prober({ [HOME]: ok }), HOME, null)).address).toBe(HOME);
  });
});

describe("routedFetch", () => {
  const setup = (answers: Record<string, ProbeResult>, alternate: string | null = VPN) => {
    const route = newRoute(HOME, alternate);
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      if (url.startsWith(HOME)) throw new Error("connection failed");
      return { status: 200, text: async () => "{}" };
    };
    const fetch = routedFetch(fetchImpl, () => route, makeReselect(prober(answers), () => route));
    return { route, calls, fetch };
  };

  it("retries a read on the address that answers, and stays there", async () => {
    const { route, calls, fetch } = setup({ [HOME]: down, [VPN]: ok });
    const res = await fetch(`${HOME}/api/v1/x`, { method: "GET", headers: {} });
    expect(res.status).toBe(200);
    expect(calls).toEqual([`${HOME}/api/v1/x`, `${VPN}/api/v1/x`]);
    expect(route.active).toBe(VPN);
    await fetch(`${HOME}/api/v1/y`, { method: "GET", headers: {} });
    expect(calls.at(-1)).toBe(`${VPN}/api/v1/y`);
  });

  it("never repeats a write that may already have reached the server, but moves for the next one", async () => {
    const { route, calls, fetch } = setup({ [HOME]: down, [VPN]: ok });
    await expect(fetch(`${HOME}/api/v1/x`, { method: "POST", headers: {} })).rejects.toThrow("connection failed");
    expect(calls).toHaveLength(1);
    expect(route.active).toBe(VPN);
  });

  it("reports the failure when neither address answers", async () => {
    const { route, fetch } = setup({ [HOME]: down, [VPN]: down });
    await expect(fetch(`${HOME}/api/v1/x`, { method: "GET", headers: {} })).rejects.toThrow("connection failed");
    expect(route.active).toBe(HOME);
  });

  it("behaves as before with one address", async () => {
    const { calls, fetch } = setup({ [HOME]: down }, null);
    await expect(fetch(`${HOME}/api/v1/x`, { method: "GET", headers: {} })).rejects.toThrow("connection failed");
    expect(calls).toHaveLength(1);
  });
});

describe("alternateTrust", () => {
  const probe = (fingerprint: string): ProbeResult => ({ reachable: true, fingerprint });
  it("accepts the certificate we already trust", () => {
    expect(alternateTrust("tauri", "AB", probe("ab"))).toEqual({ kind: "same", fingerprint: "ab" });
  });
  it("refuses a different certificate", () => {
    expect(alternateTrust("tauri", "ab", probe("cd"))).toEqual({ kind: "mismatch" });
  });
  it("asks the person when there's no pin to compare with", () => {
    expect(alternateTrust("tauri", null, probe("cd"))).toEqual({ kind: "confirm", fingerprint: "cd" });
  });
  it("relies on the OS for a certificate it validates", () => {
    expect(alternateTrust("tauri", "ab", { reachable: true, trustedByOs: true })).toEqual({ kind: "os" });
  });
});
