# Monorepo folder structure

pnpm workspaces + Turborepo. Rationale for the split is in
[architecture.md](architecture.md) and [ADR-0001](adr/0001-backend-framework.md)/
[ADR-0002](adr/0002-desktop-framework.md).

```
personal-finance-ai/
├── apps/
│   ├── server/                    # Fastify backend — the only app that touches the DB
│   │   ├── src/
│   │   │   ├── modules/           # one folder per domain, each owns its routes+service+repo
│   │   │   │   ├── auth/
│   │   │   │   ├── devices/       # device sessions (list/revoke)
│   │   │   │   ├── household/     # users within the single household
│   │   │   │   ├── accounts/
│   │   │   │   ├── transactions/
│   │   │   │   ├── categories/
│   │   │   │   ├── budgets/
│   │   │   │   ├── cashflow/      # sankey + monthly summaries
│   │   │   │   ├── investments/
│   │   │   │   ├── goals/
│   │   │   │   ├── reports/
│   │   │   │   ├── ai/            # Ollama proxy, chat history, AI settings
│   │   │   │   └── settings/
│   │   │   ├── plugins/           # fastify-plugin wrappers: db, redis, auth, ollama-client, cors
│   │   │   ├── db/
│   │   │   │   ├── schema/        # drizzle schema, one file per table group
│   │   │   │   └── migrations/    # drizzle-kit generated SQL
│   │   │   ├── setup-wizard/      # first-run-only routes, disabled after completion
│   │   │   └── app.ts             # fastify instance assembly
│   │   ├── test/
│   │   └── package.json
│   │
│   └── desktop/                   # Tauri 2.x app
│       ├── src/                   # React frontend (this is what Phase 2 iOS reuses)
│       │   ├── modules/           # mirrors server modules 1:1: dashboard, accounts, transactions...
│       │   ├── routes/
│       │   ├── stores/            # client state (Zustand) — auth, connection status, theme
│       │   ├── api/               # thin wrapper around packages/shared's typed client
│       │   └── app.tsx
│       ├── src-tauri/             # Rust shell: tray, secure storage, updater, window config
│       │   ├── tauri.conf.json
│       │   ├── capabilities/
│       │   └── icons/
│       └── package.json
│
├── packages/
│   ├── shared/                    # zod schemas, DTO types, typed API client — imported by server + desktop
│   │   ├── src/
│   │   │   ├── schemas/           # one zod schema per resource, mirrors apps/server/modules
│   │   │   ├── api-client/        # fetch wrapper, streaming NDJSON reader, version-check interceptor
│   │   │   └── openapi/           # zod-to-openapi generation, output consumed by future Swift codegen
│   │   └── package.json
│   │
│   ├── design-tokens/             # CSS custom properties extracted from design/reference (Nocturne)
│   │   └── src/tokens.css
│   │
│   └── ui/                        # shared React component library built on design-tokens
│       ├── src/
│       │   ├── primitives/        # Button, Input, Card, Tag, Dialog, Nav — ports of the Nocturne classes
│       │   └── charts/            # Sankey, bar chart — pointer- and touch-agnostic, no hover-only affordances
│       └── package.json
│
├── docker/
│   ├── docker-compose.yml         # postgres, redis, server, ollama (all with sane defaults)
│   ├── Dockerfile.server
│   └── certs/                     # self-signed cert generation script used by the setup wizard
│
├── design/
│   └── reference/                 # imported Claude Design source of truth (already in repo)
│
├── docs/
│   ├── architecture.md
│   ├── folder-structure.md        # this file
│   ├── database-schema.md
│   ├── api-design.md
│   ├── roadmap.md
│   ├── self-hosting.md            # first-class deliverable: setup, TLS trust, Ollama hardware guidance
│   └── adr/
│
├── .github/
│   └── workflows/
│       ├── ci.yml                 # lint, typecheck, test on every push/PR
│       └── release-desktop.yml    # builds Windows/macOS/Linux artifacts on tag push
│
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

## Why this split, specifically

- **`packages/shared` is the contract.** Both `apps/server` and `apps/desktop`
  import the same Zod schemas — a request body that fails validation on the
  server is the same shape the client's form already validated against. When
  Phase 2 needs an iOS client, `packages/shared/src/openapi` is the artifact a
  Swift codegen tool consumes; nothing in `apps/server` needs to change.
- **`packages/ui` is deliberately not `apps/desktop/src/components`.** Keeping
  it a separate package with no Tauri-specific imports is what makes "reusable
  by a future mobile client without a rewrite" true rather than aspirational —
  it's a compile-time guarantee, not a discipline the team has to remember.
- **`apps/server/src/modules/*` and `apps/desktop/src/modules/*` mirror each
  other 1:1.** A contributor adding a feature to Investments touches the same
  relative path on both sides, which keeps the "reusable, growing over time"
  goal from the spec concrete instead of aspirational.
