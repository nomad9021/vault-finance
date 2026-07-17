# Releasing

Every release ships: Windows MSI + NSIS, macOS `.dmg` (Intel + Apple
Silicon), Linux `.deb` + AppImage, updater artifacts, and a `latest.json`
manifest the desktop auto-updater polls. All of it is built by
[release-desktop.yml](../.github/workflows/release-desktop.yml) on a tag
push — **no manual build step, no local Mac** (spec constraint).

## Cutting a release

```bash
node scripts/set-version.mjs 0.2.0
git commit -am "Release v0.2.0"
git tag v0.2.0
git push && git push --tags
```

CI builds all platforms and creates a **draft** GitHub release. Spot-check
the artifacts, then click **Publish**. Publishing is what makes
`releases/latest/download/latest.json` resolve — existing installs see the
update on their next check.

Bump `minClientVersion` in `apps/server/src/config.ts` only when a release
genuinely breaks older clients — it makes servers reject them with an
"update required" screen (HTTP 426).

## One-time repository setup

1. Create the GitHub repository and push. Then update the updater endpoint in
   `apps/desktop/src-tauri/tauri.conf.json` — it currently points at the
   placeholder `masonchen/vault-finance`; set your real `owner/repo`.
2. Add the updater signing key as Actions secrets
   (Settings → Secrets and variables → Actions):
   - `TAURI_SIGNING_PRIVATE_KEY` — contents of `~/.tauri/vault-finance.key`
     (generated 2026-07-16 on nomad01; **back this file up** — losing it
     permanently breaks auto-update for every installed copy)
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — empty string (key has no password)

Unsigned-OS builds still work without any further secrets: Windows shows a
SmartScreen warning, macOS requires right-click → Open on first launch. The
updater artifacts are always signed with the Tauri key above regardless —
that signature is what the auto-updater verifies.

## macOS signing & notarization (one-time, browser + CLI, no Mac needed)

Without these, the `.dmg` works but Gatekeeper warns. With them, it opens
clean. All steps happen in a browser or in CI:

1. Enroll in the [Apple Developer Program](https://developer.apple.com/programs/)
   ($99/yr) — browser only.
2. Create a **Developer ID Application** certificate:
   - Generate a CSR + private key locally:
     `openssl req -new -newkey rsa:2048 -nodes -keyout mac-sign.key -out mac-sign.csr`
   - Upload `mac-sign.csr` at developer.apple.com → Certificates → “Developer
     ID Application”. Download the issued `.cer`.
   - Bundle into a p12:
     `openssl pkcs12 -export -inkey mac-sign.key -in developerID_application.cer -out mac-sign.p12`
3. Create an app-specific password at appleid.apple.com → Sign-In & Security.
4. Add the Actions secrets:
   - `APPLE_CERTIFICATE` — `base64 -w0 mac-sign.p12`
   - `APPLE_CERTIFICATE_PASSWORD` — the p12 export password
   - `APPLE_SIGNING_IDENTITY` — e.g. `Developer ID Application: Mason Chen (TEAMID)`
   - `APPLE_ID` — your Apple ID email
   - `APPLE_PASSWORD` — the app-specific password from step 3
   - `APPLE_TEAM_ID` — from developer.apple.com → Membership

`tauri-action` picks these up automatically and signs + notarizes in CI.
(The same Apple account setup is reused for the Phase 2 iOS build.)

## Windows Authenticode (optional)

Buy a code-signing certificate (OV or EV) from any CA, export as p12, add
`WINDOWS_CERTIFICATE` (base64) and `WINDOWS_CERTIFICATE_PASSWORD` secrets.
Without it, installers work but SmartScreen warns until reputation builds.

## How auto-update works end to end

1. `release-desktop.yml` builds each installer **plus** a `.sig` file
   (minisign signature using `TAURI_SIGNING_PRIVATE_KEY`) and a `latest.json`
   listing version, per-platform URLs, and signatures.
2. The app polls `releases/latest/download/latest.json` when the user clicks
   “Check for updates” (Settings → Application). No background phoning home.
3. If `latest.json`'s version is newer, the app downloads the platform
   package, verifies its signature against the **public key baked into the
   binary** (`tauri.conf.json` → `plugins.updater.pubkey`), installs, and
   relaunches. A bad or unsigned artifact is rejected before install.
