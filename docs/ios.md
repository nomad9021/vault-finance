# iOS app

The iPhone app is the desktop app's own Tauri shell built for iOS: same React
screens, same Rust transport (pinned TLS, keychain), same server API. There is
no separate codebase. Below 900 px wide the shell already switches to the phone
layout (bottom tab bar), which is what the iPhone gets.

## What differs on iPhone

| | Desktop | iPhone |
|---|---|---|
| Sign-in secrets | OS keychain | iOS Keychain (same `keyring` code) |
| Biometric sign-in | Windows Hello / Touch ID / fprintd | Face ID or Touch ID (`tauri-plugin-biometric`), no passcode fallback |
| Locks when | screen lock, sleep, idle, Ctrl/Cmd+L | all of those, plus the moment the app leaves the screen |
| Updates | in-app updater | install the new build onto the phone |
| Tailscale | in-app on/off (CLI) | turn on the Tailscale iOS app; the in-app control is hidden |
| Admin console window | yes | no (one window) |
| Outside links | default browser | Safari (`tauri-plugin-opener`) |

iOS-only files: `apps/desktop/src-tauri/tauri.ios.conf.json` (single window,
iOS 16+), `Info.ios.plist` (Face ID and local-network prompts) and
`capabilities/ios.json` (no updater permission). The stylesheet's
`:root[data-platform="ios"]` rules keep the header and tab bar clear of the
notch and home indicator.

## Building (on a Mac)

Needs Xcode, an Apple ID signed into Xcode (a free one works; its installs
expire after 7 days), and the Rust iOS targets:

```sh
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
pnpm install
cd apps/desktop
pnpm ios:init      # once: generates src-tauri/gen/apple (git-ignored)
pnpm ios:dev       # Simulator, live reload from Vite
pnpm ios:build     # signed .ipa for your own iPhone
```

Before the first device build, set your team in Xcode
(`src-tauri/gen/apple/*.xcodeproj` → Signing & Capabilities) or export
`APPLE_DEVELOPMENT_TEAM`.

## Connecting to the server

The phone connects the same way the desktop does: enter the server address,
check the certificate fingerprint, sign in, approve the device from a trusted
one. At home use the LAN address; away from home, turn on Tailscale and use the
server's Tailscale name. The first connection on the LAN triggers iOS's
"find devices on your local network" prompt, which must be allowed.
