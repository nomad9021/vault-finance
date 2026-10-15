# ADR-0009: New devices must be approved before they can sign in

## Status

Accepted.

## Context

A password (plus an optional TOTP code) was the only thing standing between
someone and the household's finances. A leaked or guessed password, or a
member's password typed on a borrowed computer, was enough to sign in from
anywhere that could reach the server. We want the server itself to decide
which devices may sign in — a second factor that's about *the device*, and
that the household controls without any third party.

## Decision

- **Device identity, saved on the device.** Each install creates a random
  `deviceId` (UUID) and `deviceSecret` (32 random bytes) per server and keeps
  them in the OS keychain (`device-identity:<server>`; the app's settings file
  if no keychain is available; `localStorage` in the phone viewer). The
  server stores only an argon2 hash of the secret, in `trusted_devices`, one
  row per (user, device).
- **The gate.** Every sign-in path (`/auth/login`, `/auth/login/device-key`)
  runs the device check *after* the password and TOTP succeed, so approvers
  only ever see requests from someone who knew the password. An unapproved
  device gets `403 DEVICE_APPROVAL_REQUIRED` with `{ approvalId, code,
  expiresAt, methods }` and polls `POST /auth/device-approval/status` (proving
  possession of the device secret). Requests last 15 minutes; at most 5 open
  per user.
- **Two ways to approve, owner chooses** (`/devices/approval-settings`; at
  least one stays on):
  - *From a trusted device* — signed-in devices poll for pending requests and
    show a prompt. The approver must **type the 6-digit code shown on the new
    device** (number matching), so a reflexive "Allow" can't let an attacker
    in. Five wrong codes deny the request. Members approve their own devices;
    the owner can approve anyone's.
  - *On the server console* — `docker compose exec server vault approve
    <code>`. Shell access to the server is the credential. `--override`
    approves even when console approval is turned off: the recovery path for
    an owner locked out of every device (anyone with that shell could edit the
    database anyway, so this adds no new power).
- **One session per approval.** Approval sets `login_ready`; the waiting
  device's next poll atomically clears it and receives a session. Later polls
  get `expired`, so the device secret alone can never mint sessions — after
  approval the device signs in normally with its password.
- **Sessions belong to devices.** `device_sessions.trusted_device_id` links
  each session to its device; removing a device revokes its sessions.
- **No lockouts on upgrade.**
  - The owner's first device on a server with no approved devices at all is
    approved automatically ("bootstrap") — the same trust as completing setup.
  - Sessions created before this change are adopted on their next refresh:
    the device is recorded as approved ("existing-session").
  - Biometric device keys carry their device's earlier trust ("device-key").
- **Old apps** that send no identity get `403 DEVICE_NOT_TRUSTED` with a
  message to update.

## Consequences

- Signing in on a new device now needs a second person/device or server
  access. Reinstalling the app or clearing the keychain counts as a new device.
- If every approved device is removed, the owner's next sign-in bootstraps
  again (password still required). Removing all devices is therefore not a
  lock-the-door action; changing the password is.
- The console code list (`vault pending`) is the only place codes are shown
  besides the requesting device; the API never returns them to approvers.
