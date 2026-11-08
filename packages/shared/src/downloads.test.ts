import { describe, expect, it } from "vitest";
import { appDownloads, inviteMessage } from "./downloads.js";

describe("appDownloads", () => {
  it("links each computer to that version's installer", () => {
    expect(appDownloads("0.1.18")).toEqual([
      { label: "Mac (Apple chip)", url: "https://github.com/nomad9021/vault-finance/releases/download/v0.1.18/Vault.Finance_0.1.18_aarch64.dmg" },
      { label: "Mac (Intel)", url: "https://github.com/nomad9021/vault-finance/releases/download/v0.1.18/Vault.Finance_0.1.18_x64.dmg" },
      { label: "Windows", url: "https://github.com/nomad9021/vault-finance/releases/download/v0.1.18/Vault.Finance_0.1.18_x64-setup.exe" },
      { label: "Linux", url: "https://github.com/nomad9021/vault-finance/releases/download/v0.1.18/Vault.Finance_0.1.18_amd64.AppImage" },
    ]);
  });
});

describe("inviteMessage", () => {
  it("has the downloads, the invite link and where to connect", () => {
    const text = inviteMessage({
      inviterName: "Pat",
      inviteUrl: "https://192.168.1.122:8443/invite?token=a.b",
      serverAddress: "https://192.168.1.122:8443",
      version: "0.1.19",
    });
    expect(text).toContain("Pat invited you to Vault Finance.");
    expect(text).toContain("Windows: https://github.com/nomad9021/vault-finance/releases/download/v0.1.19/");
    expect(text).toContain("Linux: ");
    expect(text).toContain("Mac (Intel): ");
    expect(text).toContain("https://192.168.1.122:8443/invite?token=a.b");
    expect(text).toContain("connect to https://192.168.1.122:8443");
  });
});
