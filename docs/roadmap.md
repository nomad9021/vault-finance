# Development roadmap

Small, sequential milestones. Each milestone should be independently mergeable
and leave the app in a working (if incomplete) state — no big-bang integration
at the end.

## M0 — Planning (this work)

- [x] Import Claude Design source of truth into `design/reference/`
- [x] `architecture.md`, ADRs, `folder-structure.md`, `database-schema.md`,
      `api-design.md`, this roadmap
- [ ] Scaffold the monorepo itself (pnpm workspaces, Turborepo, empty
      `apps/server`, `apps/desktop`, `packages/shared`, `packages/design-tokens`,
      `packages/ui`) — no features yet, just a repo that installs and builds

## M1 — Backend core + auth + setup wizard

- Fastify app skeleton, Drizzle schema + first migration (from
  `database-schema.md`), `docker-compose.yml` with `postgres`, `redis`,
  `server`, `ollama` services
- Self-signed cert generation on first boot ([ADR-0004](adr/0004-tls-trust.md))
- Setup wizard API (`/api/v1/setup/*`) + auth module
  ([ADR-0003](adr/0003-auth-design.md)): login, refresh, logout, device
  sessions
- Default category seed data
- **Exit criteria**: `docker compose up` produces a server you can complete
  setup against and log into with `curl`, with a real Postgres-backed user and
  a working access/refresh token cycle.

## M2 — Desktop app shell

- Tauri 2 project bootstrap for `apps/desktop`, wired to `packages/shared`'s
  API client
- Connect-to-server screen (address entry, TOFU cert pinning UX)
- Setup wizard UI + login screen, matching the design's splash/login treatment
  in `design/reference/Finance App v3.dc.html`
- Theme system: Light, Dark, OLED Black, High Contrast, Automatic — sourced
  from `packages/design-tokens`
- Native window chrome, system tray, per-OS menu bar conventions
- Reconnect/offline banner state
- **Exit criteria**: a signed-in, empty-state desktop app running on
  Windows/macOS/Linux dev machines, showing live connection status against a
  Dockerized server.

## M3 — Core modules: Accounts, Transactions, Budgets

- Full CRUD UI + API wiring for all three, following the design's Dashboard,
  Accounts, Transactions, and Budgets pages
- CSV transaction import with dedupe
- Search, filtering, pagination on the transactions list
- **Exit criteria**: a household's real financial data can be entered, edited,
  categorized, and budgeted against — the app is useful without AI at this
  point.

## M4 — AI assistant integration

- `ollama` service wired with configurable host/port/model
  ([architecture.md](architecture.md#ai-integration))
- Streaming chat endpoint ([ADR-0005](adr/0005-ai-streaming.md)) + Assistant
  page UI with prompt chips, matching the design
- AI status indicator + graceful-degradation states across every AI-touching
  surface (Dashboard insight card, Assistant, Reports)
- Settings → AI page: host/port/model config, connection test
- **Exit criteria**: natural-language questions against real transaction data
  produce streamed answers; pulling the `ollama` container down doesn't break
  anything else in the app.

## M5 — Cash Flow (Sankey), Investments, Savings Goals, Reports

- Cash Flow module with the interactive drill-down Sankey diagram (the
  `sankeyGeo()`/`buildSankey()` logic in the design reference is the layout
  algorithm to port), animated transitions on category drill-in
- Investments module: holdings, allocation breakdown, per-account YTD
- Savings Goals module: progress bars, ETA, linked-account derivation
- Reports module: monthly/yearly summaries, AI-generated commentary
  (cached via `monthly_report_snapshots`)
- **Exit criteria**: every module in the spec's list is implemented and
  visually matches the design reference.

## M6 — CI pipeline + installers + auto-update

- `ci.yml`: lint, typecheck, unit tests on every push/PR across all workspace
  packages
- `release-desktop.yml`: on tag push, builds
  - Windows: MSI or NSIS
  - macOS: `.dmg`, built entirely on a `macos-latest` GitHub Actions runner —
    no local Xcode/macOS required; manual notarization steps (Apple Developer
    account, notarytool credentials as repo secrets) documented in
    `self-hosting.md`/a release-runbook doc, performed once in a browser/CLI,
    not per-release
  - Linux: `.deb` + AppImage
- Tauri's built-in updater wired to signed release artifacts + an update
  manifest published alongside each GitHub release
- Shared semantic version across server and all clients; `/api/v1/version`
  compatibility check ([architecture.md](architecture.md)) exercised in CI
  with a deliberately-mismatched client fixture
- **Exit criteria**: a tag push produces installable, auto-updating artifacts
  for all three desktop platforms without any manual build step.

## M7 — Polish & documentation

- Accessibility pass (keyboard navigation, focus states — the design system's
  `:focus-visible` treatment already establishes the pattern to extend)
- Keyboard shortcuts per platform convention
- `self-hosting.md` finalized end-to-end (a fresh user should be able to follow
  it with zero prior context)
- Hardware sizing guidance for common Ollama model sizes, validated against
  real measurements from M4
- ADR backlog cleared — every non-obvious decision made along the way gets a
  record

## Explicitly out of scope for Phase 1

- Any iOS code. `packages/ui` and `packages/shared` are built to make Phase 2
  additive, not to include a partial iOS target now.
- Bank aggregation / Plaid-style live account sync — the spec's transaction
  input path is manual entry + CSV import; automated bank sync is a plausible
  Phase 3+ but isn't implied by anything in the current spec and would
  introduce exactly the third-party network dependency the privacy
  requirements rule out unless carefully scoped later.
