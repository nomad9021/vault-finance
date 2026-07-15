# ADR-0003: Auth — short-lived JWT + rotating refresh token + per-device sessions

## Status

Accepted

## Context

Auth must work identically for desktop now and iOS later, support per-device
visibility/revocation, and not depend on browser-only mechanisms (cookies,
`EventSource`) since the AI streaming endpoint needs a bearer token on every
request.

## Decision

- Access token: JWT, 15-minute expiry, signed with a server-held secret
  (rotatable via env var), carries `userId` and `deviceSessionId`.
- Refresh token: opaque random value, stored **hashed** (argon2) in a
  `device_sessions` row alongside device name, platform, IP, `created_at`,
  `last_used_at`, `revoked_at`. Rotated on every use (old value invalidated the
  moment a new one is issued) so a leaked-and-replayed refresh token is
  detectable — replay of an already-rotated token revokes the whole session
  chain.
- Clients send the access token as `Authorization: Bearer`. No cookies, no
  session affinity — works the same for a Tauri webview fetch call and (later)
  a Swift `URLSession` call.
- `GET /api/v1/auth/sessions` / `DELETE /api/v1/auth/sessions/:id` let a user
  see and kill any device's session from Settings, per the spec's requirement.

## Consequences

Refresh happens on a timer client-side (roughly every 10 minutes) and
opportunistically on a 401. The client must handle "refresh itself failed" by
dropping to the login screen cleanly, including mid-stream during an AI chat
response — the streaming endpoint must treat an expired token as a hard stop,
not a silent hang.
