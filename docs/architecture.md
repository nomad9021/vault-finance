# Architecture

## Summary

Vault Finance is a client–server system. Each user runs one **server** on their own
hardware (Docker Compose); every household member connects to it with a **desktop
app** (Windows/macOS/Linux, Phase 1) and, later, an **iOS app** (Phase 2) that
speaks the same API. There is no multi-tenant cloud component — the maintainer of
this codebase never sees a user's data or runs any infrastructure for them.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Backend | Node.js 22 + TypeScript, Fastify | See [ADR-0001](adr/0001-backend-framework.md) |
| ORM / migrations | Drizzle ORM + drizzle-kit | SQL-first, typed, no codegen step, small runtime — fits a self-hosted single-instance app better than Prisma's engine binary |
| Validation / contracts | Zod, `zod-to-openapi` | One schema drives request validation, response typing, and a generated OpenAPI doc future clients (incl. Swift) can codegen against |
| Database | PostgreSQL 16 | Requested; correct choice for relational financial data with strong constraints |
| Cache / sessions | Redis 7 (optional) | Refresh-token revocation lookups, login rate-limiting, cached dashboard aggregates. The server runs without it — see degrade-gracefully note below |
| Local AI | Ollama, HTTP API | Requested; self-hosted, no cloud AI calls ever |
| Desktop shell | Tauri 2.x | See [ADR-0002](adr/0002-desktop-framework.md) |
| Frontend | React + TypeScript + Vite | Matches the existing Claude Design source-of-truth (`design/reference/Finance App v3*.dc.html`), reusable for Phase 2 iOS via Tauri 2's iOS target |
| Monorepo tooling | pnpm workspaces + Turborepo | Shared TS types between server and desktop without publishing packages |

## Network diagram

```mermaid
flowchart TB
    subgraph UserHardware["User's own hardware (Docker Compose host)"]
        direction TB
        PG[(PostgreSQL)]
        RD[(Redis — optional)]
        OL[Ollama<br/>local AI runtime]
        SRV[Vault Finance Server<br/>Fastify + TypeScript<br/>HTTPS :8443]
        SRV -->|SQL| PG
        SRV -->|token cache, rate limit| RD
        SRV -->|HTTP, streaming| OL
    end

    subgraph Clients["Client devices"]
        DW[Desktop — Windows]
        DM[Desktop — macOS]
        DL[Desktop — Linux]
        IOS["iOS app (Phase 2, later)"]
    end

    DW -->|HTTPS + access/refresh JWT| SRV
    DM -->|HTTPS + access/refresh JWT| SRV
    DL -->|HTTPS + access/refresh JWT| SRV
    IOS -.->|same REST/streaming API,<br/>not built in Phase 1| SRV

    Net["LAN, or VPN/overlay<br/>(e.g. Tailscale) for remote access"]
    Clients --- Net --- SRV
```

Every arrow into `SRV` uses the same versioned REST API described in
[api-design.md](api-design.md). Nothing in the diagram is specific to desktop —
that's intentional, so the Phase 2 iOS app is a new client on this diagram, not a
new backend.

## Client–server connectivity

- **Server address is user-configured.** No client hardcodes `localhost`. The
  desktop app's first-run flow asks for a host (LAN hostname/IP, or a Tailscale
  MagicDNS name) and a port, stores it locally (OS keychain via Tauri's
  secure-storage plugin holds the refresh token; the address itself is plain
  config), and every subsequent request goes through one `ApiClient` instance
  built from that config.
- **TLS is mandatory, trust is Trust-On-First-Use (TOFU).** The server always
  serves HTTPS. For a proper CA-issued cert (e.g. the user fronts the server with
  Caddy/Let's Encrypt, or connects over Tailscale's HTTPS), normal validation
  applies. For the common self-hosted case (self-signed cert, or the internal CA
  the setup wizard generates), the client pins the certificate's SHA-256
  fingerprint on first connect — exactly like an SSH host key — and warns loudly
  if it ever changes. This avoids asking a non-technical household member to
  import a root CA into their OS trust store. Documented in
  [self-hosting.md](self-hosting.md).
- **Auth**: short-lived access JWT (15 min) + rotating opaque refresh token,
  bound to a per-device session row the user can list and revoke from Settings.
  Detailed in [ADR-0003](adr/0003-auth-design.md) and
  [api-design.md](api-design.md).
- **Reconnection**: the API client wraps every call; on network failure it
  surfaces a global "Reconnecting…" banner state (not a full-screen error),
  retries with backoff, and queues no writes — in-flight mutations fail
  explicitly rather than silently retrying, so the user never wonders whether a
  transaction was saved twice.
- **Version compatibility**: `GET /api/v1/version` returns the server's API
  version and its `minClientVersion`. Every client request sends
  `X-Client-Version`; the server responds `426 Upgrade Required` with a
  human-readable message if the client is below `minClientVersion`, which the
  client renders as a blocking "please update" screen instead of failing
  opaquely.

## AI integration

- Ollama runs as an optional service in the same Docker Compose stack
  (`ollama/ollama` image) but the server never assumes it's local — `OLLAMA_HOST`
  / `OLLAMA_PORT` / `OLLAMA_MODEL` are configurable via env var and in
  Settings → AI, so a user can point at a beefier Ollama box elsewhere on their
  LAN.
- The server proxies Ollama's streaming `/api/chat` as newline-delimited JSON
  (NDJSON) over a chunked HTTP response, not Server-Sent Events — `EventSource`
  can't send an `Authorization` header, and this API is bearer-token
  authenticated end to end. The desktop client reads the response body with a
  `ReadableStream` reader and appends tokens as they arrive.
- If Ollama is unreachable, `GET /api/v1/ai/status` reports
  `{ reachable: false, ... }`; every AI-touching module (Dashboard insight card,
  Assistant page, Reports commentary) checks this and renders a "connect AI"
  affordance instead of failing. No other module depends on AI being present.

## Where Phase 2 (iOS) fits

Nothing above is desktop-specific by design:

- The API is the same REST/streaming contract regardless of client.
- Auth already models "per-device session," not "per-desktop-session" — an iOS
  device is just another row.
- Tauri 2 targets iOS from the same Rust shell + web frontend, so the
  `apps/desktop` frontend (React components, API client, state) is the intended
  starting point for `apps/ios` in Phase 2, not a rewrite.
- The one Phase-1 decision that would make Phase 2 harder if done wrong: baking
  desktop-only assumptions (hover states as the only affordance, fixed-width
  layouts, filesystem-path-based config) into shared components. The component
  library in `packages/ui` must stay pointer/touch-agnostic — see
  [folder-structure.md](folder-structure.md).

## Privacy & deployment posture

- No telemetry, analytics, or crash reporting phones home, anywhere in the
  stack.
- Uploaded receipts/exports/backups are Docker volumes on the user's host,
  never proxied through or copied to any third party.
- The only outbound network call from a shipped binary that isn't the user's
  own server is the desktop auto-updater checking/downloading a new release.
