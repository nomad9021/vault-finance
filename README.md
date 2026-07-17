# Vault Finance

Self-hosted, AI-powered personal finance. Your data, your AI, your server —
nothing ever leaves your hardware.

- **Server**: Fastify + PostgreSQL, deployed with a single `docker compose up`
  on your own machine ([self-hosting guide](docs/self-hosting.md)).
- **Desktop apps**: Windows / macOS / Linux (Tauri 2 + React), connecting to
  your server over LAN or Tailscale. *(in progress — see the
  [roadmap](docs/roadmap.md))*
- **AI**: local models via Ollama on your own hardware. No cloud APIs, no
  telemetry, ever.

## Documentation

| Doc | What it covers |
|---|---|
| [architecture.md](docs/architecture.md) | System overview, network diagram, where the future iOS client fits |
| [folder-structure.md](docs/folder-structure.md) | Monorepo layout |
| [database-schema.md](docs/database-schema.md) | PostgreSQL schema |
| [api-design.md](docs/api-design.md) | REST API, auth flows, streaming |
| [roadmap.md](docs/roadmap.md) | Milestones M1–M6 |
| [self-hosting.md](docs/self-hosting.md) | Deploying and operating your server |
| [docs/adr/](docs/adr/) | Architecture decision records |

## Development

Requirements: Node 22+, pnpm 9 (via corepack), Docker (for the full stack).

```bash
pnpm install
pnpm build          # build all workspace packages
pnpm test           # server e2e tests run against a real embedded Postgres
pnpm --filter @vault/server dev   # dev server with hot reload
```

The server dev process needs a `DATABASE_URL` pointing at any Postgres 16+;
`docker compose -f docker/docker-compose.yml up -d postgres` gives you one.

## Status

- **M1 — backend core**: complete. Auth (short-lived access + rotating
  refresh tokens, per-device sessions), first-run setup wizard, HTTPS with
  generated self-signed certs, migrations, Docker Compose stack.
- **M2 — desktop app shell**: complete. Tauri 2 + React app with
  connect-to-server (TOFU certificate pinning per ADR-0004), setup wizard UI,
  profile-picker login, app shell matching the Nocturne design, five themes,
  offline/reconnect handling, OS-keychain token storage, tray icon. The
  frontend flow is verified end-to-end against a live server; the Rust shell
  compiles in CI (M6) — building it locally needs the Tauri Linux
  prerequisites (webkit2gtk, libappindicator).

- **M3 — core modules**: complete. Accounts (grouped list, net-worth stats,
  archive-vs-delete), transactions (cursor pagination, merchant full-text
  search, category/account filters, CSV import with idempotent dedupe,
  balance-tracking mutations), categories (system + custom, in-use
  protection), and month-versioned budgets with live spent-vs-budget bars.
  The app is now useful without AI.

- **M4 — AI assistant**: complete. Streaming chat (NDJSON per ADR-0005)
  through a server-side Ollama proxy that injects a live snapshot of the
  household's real accounts, spending, and budgets; assistant page with
  prompt chips; persisted conversations; Settings → AI with connection test
  and model picker; graceful offline states everywhere. Docker stack and
  Tauri Rust shell now verified on a real machine.

- **M5 — Sankey, Investments, Goals, Reports**: complete. The flagship
  interactive cash-flow Sankey on the dashboard (click any node to drill into
  its transactions, weekly/monthly/yearly views), 6-month income-vs-spending
  cash flow page, investments with user-entered valuations and allocation,
  savings goals with linked-account progress and projected completion,
  monthly/yearly reports with cached AI commentary, and CSV export.
  `scripts/seed-demo.mjs` fills a dev server with realistic data.

- **M6 — CI, installers, auto-update**: complete. `ci.yml` runs typecheck,
  the full e2e suite (including the client-version-compatibility fixture),
  a Tauri `cargo check`, and the Docker image build on every push. A tag
  push triggers `release-desktop.yml`: MSI/NSIS, `.dmg` for both Mac
  architectures (built entirely on GitHub's macOS runners — no local Mac),
  `.deb` + AppImage, all with signed updater artifacts and a `latest.json`
  manifest. In-app updates live in Settings → Application. See
  [releasing.md](docs/releasing.md) for the runbook.

Phase 1 milestones are complete. Remaining before a public release:
M7 polish (accessibility, shortcuts, docs finalization) and pushing the
repo to GitHub (one-time setup in [releasing.md](docs/releasing.md)).
