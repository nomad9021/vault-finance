# Desktop installers

The desktop app (Windows / macOS / Linux) is a [Tauri](https://tauri.app)
application. Its **source** lives in [`../../apps/desktop`](../../apps/desktop);
the **installers** are produced by CI and published on the project's GitHub
Releases page — they are not checked into the repo.

## Getting an installer

### Download a release (recommended)

Grab the file for your OS from the
[Releases page](https://github.com/nomad9021/vault-finance/releases/latest):

| OS | File | Notes |
|---|---|---|
| Windows | `Vault Finance_<version>_x64-setup.exe` (NSIS) or `..._x64_en-US.msi` | SmartScreen may warn until the app builds reputation (unsigned). |
| macOS (Apple Silicon) | `Vault Finance_<version>_aarch64.dmg` | Gatekeeper blocks the first launch unless notarized; see [below](#first-launch-on-macos). |
| macOS (Intel) | `Vault Finance_<version>_x64.dmg` | Same first-launch note. |
| Linux | `Vault Finance_<version>_amd64.AppImage` or `..._amd64.deb` | `chmod +x` the AppImage, or `sudo dpkg -i` the `.deb`. |

After installing, open the app and point it at your server address
(`https://<server-ip>:8443` by default). See the main
[README](../../README.md#3-connect-the-desktop-app) for the connect flow.

#### First launch on macOS

Builds that aren't notarized need a one-time approval after you drag the app
to Applications:

- **macOS 15 (Sequoia) and later:** open the app and dismiss the warning, then
  go to System Settings → Privacy & Security, scroll to Security, click
  **Open Anyway** next to Vault Finance, and confirm.
- **macOS 14 (Sonoma) and earlier:** right-click the app → Open, then confirm.

If macOS says the app **is damaged and can't be opened** (only offering Move to
Trash), the build wasn't ad-hoc signed — that's v0.1.19 and earlier. Move it to
the Trash and download a newer release; Open Anyway above then works. (Technical
users can instead clear the download quarantine on the old build:)

```bash
xattr -cr "/Applications/Vault Finance.app"
```

### Build one yourself

Requires Node 22+, pnpm 9, the Rust toolchain, and the Tauri platform
prerequisites (see the [Tauri prerequisites guide](https://tauri.app/start/prerequisites/)).

```bash
pnpm install
cd apps/desktop
pnpm tauri build
```

Bundles are written to
`apps/desktop/src-tauri/target/release/bundle/` (an `appimage/` and `deb/`
folder on Linux, `msi/` + `nsis/` on Windows, `dmg/` on macOS). Tauri only
builds installers for the OS you run it on.

## How releases are produced

A `v*` tag push runs
[`.github/workflows/release-desktop.yml`](../../.github/workflows/release-desktop.yml),
which builds every platform on GitHub's runners (including both macOS
architectures — no local Mac needed) and attaches the installers plus signed
auto-updater artifacts to a draft GitHub Release. The maintainer runbook is
[`docs/releasing.md`](../../docs/releasing.md).
