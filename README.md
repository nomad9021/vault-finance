# Vault Finance

Self-hosted, AI-powered personal finance. Your data, your AI, your server —
nothing ever leaves your hardware.

- **Server**: Fastify + PostgreSQL, deployed with Docker Compose on a machine
  you control.
- **Desktop apps**: Windows / macOS / Linux (Tauri 2 + React), connecting to
  your server over LAN or Tailscale.
- **Mobile viewer**: a read-only, password-protected phone view served by the
  server itself — open it in your phone's browser, add to home screen.
- **AI**: optional and off by default. Bring your own provider — local Ollama
  (nothing leaves your hardware), or your own OpenAI / Anthropic key. No
  telemetry, ever ([ADR-0006](docs/adr/0006-optional-multi-provider-ai.md)).

---

## Installation

You install the **server once** on an always-on machine, then install the
**desktop app** on each device you use. All the install tooling lives in
[`installers/`](installers/).

### 1. Install the server

#### Prerequisites

- A **64-bit machine that stays on** — a home server, NAS, mini-PC, or spare
  desktop. Ubuntu LTS (20.04/22.04/24.04), other Linux, or macOS all work.
- **Docker Engine + the Compose plugin.** The installer checks for these and
  stops with a clear message if they're missing.
- **git** — the server image is built from source during install.
- **Disk:** ~1 GB for app + database to start (grows with your data), plus
  **4–20 GB per AI model** if you enable local AI.
- **RAM:** 2 GB is plenty for the finance stack; add more only for a local AI
  model.

#### Ubuntu / Linux — step by step

Install Docker (official script — installs Engine, Compose, and buildx):

```bash
curl -fsSL https://get.docker.com | sudo sh
```

Make sure the Docker daemon is running now and starts on every boot:

```bash
sudo systemctl enable --now docker
```

Let your user run Docker without sudo, then **log out and back in** (or run
`newgrp docker` in the current terminal) — the new group doesn't apply to
shells that were already open:

```bash
sudo usermod -aG docker $USER
newgrp docker
```

Check it works without sudo — this should print a table, not an error:

```bash
docker ps
```

Install git if needed:

```bash
sudo apt-get update && sudo apt-get install -y git
```

Clone the repo:

```bash
git clone https://github.com/nomad9021/vault-finance.git
```

> **Note:** the installer and mobile viewer currently live on the `dev` branch
> until the first release is merged to `main`. If `installers/` isn't present
> after cloning, run `git checkout dev` inside the repo.

Run the guided installer and answer its questions:

```bash
cd ~/vault-finance
bash installers/server/install-server.sh
```

(If you're already inside the `vault-finance` folder, skip the `cd` — just run
the `bash …` line. `cd vault-finance` from inside it fails with
"No such file or directory".)

It asks:

- **Where to store your files** (`VAULT_DISK`) — put this on your big or
  dedicated drive if you have one (e.g. `/mnt/data/vault`). Holds the database,
  uploaded receipts, the TLS certificate, and any AI models.
- **HTTPS port** (default `8443`).
- **Database password** — press Enter for a strong random one. If you type
  your own, use only letters, digits and `. _ ~ -` (characters like `$` or `@`
  break the config, so the installer rejects them).
- **Local AI?** — default no; you can turn it on later in the app.
- **Owner account?** — create your login now, or later from the desktop app's
  setup wizard.

Then it writes `docker/.env`, creates the data directories, pulls the
prebuilt server image from GHCR, starts the stack, waits for the API, and
prints the address to connect to. If the prebuilt image can't be pulled (for
example it hasn't been published for your version yet — Docker reports
`error from registry: denied`), the installer **builds the server from your
checkout instead** (a few extra minutes) and records that in `docker/.env`
(`COMPOSE_FILE=docker-compose.yml:docker-compose.build.yml`) so updates keep
building from source. Delete that line to switch back to prebuilt images. Run with `--dry-run` first if you
want to preview everything without touching Docker.

If the installer stops at the Docker check, it tells you which problem it hit:

| Message | Fix |
|---|---|
| *The Docker daemon isn't running* | `sudo systemctl enable --now docker` (the installer offers to run this for you) |
| *User '…' can't talk to Docker* | `sudo usermod -aG docker $USER`, then `newgrp docker` or log out and back in |
| *You're in the 'docker' group, but this shell doesn't know yet* | Log out and back in, or run `newgrp docker` |

Warnings like `The "a" variable is not set` mean `docker/.env` has a `$` in
a value (usually the database password). Re-run the installer — it asks for a
new password.

Then re-run the installer.

#### Windows server (Docker Desktop)

```powershell
git clone https://github.com/nomad9021/vault-finance.git
cd vault-finance
pwsh -File installers\server\install-server.ps1
```

More detail — remote access, custom TLS, backups, updating, troubleshooting:
[docs/self-hosting.md](docs/self-hosting.md) and
[installers/server/](installers/server/).

### 2. Install the desktop app

Download the installer for your OS from the
[Releases page](https://github.com/nomad9021/vault-finance/releases/latest)
(`.exe`/`.msi` for Windows, `.dmg` for macOS, `.AppImage`/`.deb` for Linux),
or build it yourself — see [installers/desktop/](installers/desktop/).

### 3. Connect the desktop app

Open the app and enter your server address:

| How you reach the server | Address to enter |
|---|---|
| Same LAN | `https://192.168.x.x:8443` or `https://hostname.local:8443` |
| Tailscale / VPN | `https://<tailscale-ip-or-name>:8443` |
| Reverse proxy with real TLS | whatever hostname the proxy serves |

The server uses a self-signed certificate by default; the first connection
shows its fingerprint, you confirm once, and the app pins it. **Don't
port-forward 8443 to the open internet** — use Tailscale or a hardened reverse
proxy for remote access.

### 4. (Optional) Phone viewer

Open `https://<server-ip>:8443/` in your phone's browser for the read-only
mobile view, and add it to your home screen. It locks the moment you switch
away and signs out after a few minutes idle.

---

## Repository layout

```
apps/
  desktop/        Tauri 2 + React desktop app (source)
  server/         Fastify + PostgreSQL API server
packages/         Shared workspace packages (schemas, API client, UI, tokens)
installers/
  server/         Interactive server installers (Linux/macOS + Windows)
  desktop/        How to get / build the desktop app
docker/           Docker Compose stack + Dockerfile (the server's build context)
design/           Design references
docs/             Guides, architecture, ADRs, self-hosting, releasing
scripts/          Repo tooling (dev stack, demo seed, version bump)
```

## Documentation

| Doc | What it covers |
|---|---|
| [how-it-works.md](docs/how-it-works.md) | Feature tour — what each screen does |
| [architecture.md](docs/architecture.md) | System overview, network diagram |
| [folder-structure.md](docs/folder-structure.md) | Monorepo layout |
| [database-schema.md](docs/database-schema.md) | PostgreSQL schema |
| [api-design.md](docs/api-design.md) | REST API, auth flows, streaming |
| [self-hosting.md](docs/self-hosting.md) | Deploying and operating your server |
| [operations.md](docs/operations.md) | Data location, 2FA, backups, lockout recovery |
| [releasing.md](docs/releasing.md) | Cutting desktop releases (maintainers) |
| [roadmap.md](docs/roadmap.md) | Milestones M1–M6 |
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

Phase 1 (M1–M6) is complete: backend core, desktop app, core finance modules,
optional AI assistant, dashboard Sankey / investments / goals / reports, and
CI + cross-platform installers with auto-update. See
[roadmap.md](docs/roadmap.md) for the milestone detail and what's next.
