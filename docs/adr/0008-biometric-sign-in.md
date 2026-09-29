# ADR-0008: Biometric sign-in via a per-device key

## Status

Accepted.

## Context

Household members want to open the desktop app with Windows Hello, Touch ID,
or a fingerprint reader instead of typing a password. The biometric check has
to happen on the device (the OS never hands out biometric data, and the server
must never see it), and the server still needs something it can verify and
revoke. Until now a saved session also opened the app with no check at all.

WebAuthn/passkeys would be the textbook answer, but they need a browser origin
with a real domain and a trusted certificate; our webview talks to a
self-signed, IP-or-LAN-name server through a Rust transport (ADR-0004), so
they don't fit.

## Decision

- **Server:** a `device_keys` table. `POST /auth/device-keys` (signed-in)
  issues a random key `<id>.<secret>` — same shape and argon2 hashing as
  refresh tokens (ADR-0003). `POST /auth/login/device-key` exchanges it for a
  normal session. Keys are listed and revocable per user; a wrong secret for a
  real key id deletes the key.
- **Desktop:** turning it on in Settings runs the OS prompt, then stores the key
  in the OS keychain (`device-key:<server>:<userId>`). While enrolled, the app
  opens **locked** on the sign-in screen and prompts immediately; on success it
  resumes the saved session or, after sign-out, signs in with the key.
  Password sign-in always remains available.
- **Native checks** (`src-tauri/src/biometric.rs`):
  - Windows — `UserConsentVerifier` via `IUserConsentVerifierInterop`
    (parented to our window; face, fingerprint, or Windows Hello PIN).
  - macOS — LocalAuthentication, `DeviceOwnerAuthenticationWithBiometrics`.
  - Linux — fprintd over the system D-Bus (`net.reactivated.Fprint`); needs a
    reader supported by libfprint and an enrolled finger. 30 s scan timeout,
    cancellable from the UI.
  - iOS (Phase 2) — `tauri-plugin-biometric` behind the same `HostPlatform`
    methods.
- A biometric sign-in satisfies TOTP (ADR-0003 2FA): enrollment itself needed a
  full password(+TOTP) session, and the key alone is useless without passing
  the device's biometric check — the same possession-plus-inherence trade-off
  passkeys make.

## Consequences

The key is protected by the OS keychain plus the app's biometric gate, not by
hardware-bound attestation; malware running as the user could read the keychain
entry directly — as it already could the refresh token. Hardware-backed keys
(TPM / Secure Enclave signing) would close that gap and can replace the shared
secret later without changing the UI. The mobile web viewer is unaffected: it
has no way to do a biometric check against a self-signed server.
