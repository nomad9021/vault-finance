# Server installer

Interactive installers that set up the Vault Finance **server** (the Docker
Compose stack) on the machine that will host your data.

| Script | Platform |
|---|---|
| [`install-server.sh`](install-server.sh) | Linux / macOS |
| [`install-server.ps1`](install-server.ps1) | Windows (Docker Desktop + PowerShell) |

They ask where to store your data, which HTTPS port to use, the database
password, whether to enable local AI, and (optionally) create your owner
account — then write `docker/.env`, create the data directories, and run
`docker compose up -d --build`.

## Usage

```bash
# Linux / macOS, from the repo root
bash installers/server/install-server.sh
```

```powershell
# Windows, from the repo root
pwsh -File installers\server\install-server.ps1
```

Flags:

- `--dry-run` (`-DryRun` on Windows) — show the `.env` and planned actions
  without touching Docker.
- `--yes` / `-y` (`-Yes` on Windows) — accept all defaults / existing values,
  no prompts (headless / CI).

Re-running is safe: the installer reads your existing `docker/.env` values as
the defaults.

## What it needs

- Docker Engine + the Compose plugin (Docker Desktop on Windows/macOS).
- To be run from inside a Vault Finance checkout — it drives the compose stack
  in [`../../docker`](../../docker).

Full deployment, remote-access, TLS, backup, and troubleshooting guidance:
[`docs/self-hosting.md`](../../docs/self-hosting.md).
