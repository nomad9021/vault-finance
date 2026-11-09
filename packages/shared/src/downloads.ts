/**
 * Where people get the desktop app, so an invite can carry everything a new
 * household member needs. Installer names follow the release workflow's
 * output (release-desktop.yml), e.g. "Vault.Finance_0.1.18_x64-setup.exe".
 */
export const RELEASES_PAGE_URL = "https://github.com/nomad9021/vault-finance/releases/latest";

const DOWNLOAD_BASE = "https://github.com/nomad9021/vault-finance/releases/download";

export interface AppDownload {
  label: string;
  url: string;
}

/** Installers for one version; the app and server share a version number. */
export function appDownloads(version: string): AppDownload[] {
  const file = (suffix: string) => `${DOWNLOAD_BASE}/v${version}/Vault.Finance_${version}_${suffix}`;
  return [
    { label: "Mac (Apple chip)", url: file("aarch64.dmg") },
    { label: "Mac (Intel)", url: file("x64.dmg") },
    { label: "Windows", url: file("x64-setup.exe") },
    { label: "Linux", url: file("amd64.AppImage") },
  ];
}

/**
 * A message to paste into a text or chat: install the app, open the invite
 * link to set a password, then sign in at the server's address.
 */
export function inviteMessage(input: {
  inviterName: string;
  inviteUrl: string;
  serverAddress: string;
  version: string;
}): string {
  const downloads = appDownloads(input.version)
    .map((d) => `   ${d.label}: ${d.url}`)
    .join("\n");
  return [
    `${input.inviterName} invited you to Vault Finance.`,
    "",
    "1. Install the app for your computer:",
    downloads,
    `   (All downloads: ${RELEASES_PAGE_URL})`,
    "",
    "   On a Mac: Apple menu > About This Mac shows \"Chip: Apple M...\" for Apple chip; otherwise pick Intel.",
    "   Open the downloaded file and drag Vault Finance into Applications. The first time you open it,",
    "   your Mac will say it can't check the app. Click Done, then open System Settings > Privacy & Security,",
    "   scroll down, click Open Anyway next to Vault Finance, and confirm. After that it opens normally.",
    "",
    "2. Open this link to choose your password. It works once and lasts 7 days:",
    `   ${input.inviteUrl}`,
    "",
    `3. Open Vault Finance, connect to ${input.serverAddress}, and sign in.`,
    "",
    `You need to be on our home Wi-Fi or VPN for the link and the app to reach the server. Your browser and the app may warn about the server's certificate the first time; that's expected.`,
  ].join("\n");
}
