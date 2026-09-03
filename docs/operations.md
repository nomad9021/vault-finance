# Operations & Security

How this Vault Finance instance is deployed, where its data lives, how to keep
it locked down, and how to recover if something goes wrong. This reflects the
**current running setup** (single-machine, Docker + desktop app) and
supersedes any older volume details elsewhere.

---

## 1. What runs where

Vault Finance is a **client → server** system; everything stays on your
hardware.

| Piece | What it is | How it runs |
|---|---|---|
| **Server** | Fastify + PostgreSQL API (TLS) | Docker Compose stack in `docker/docker-compose.yml` (project `vault-finance`) |
| **Postgres** | Your financial database | `postgres:16-alpine` container |
| **Redis** | Optional cache (in-memory fallback if absent) | `redis:7-alpine` container |
| **Ollama** | Optional local AI runtime | `ollama/ollama` container |
| **Desktop app** | Tauri 2 + React client | AppImage / installed app, connects to `https://localhost:8443` |

The server **bakes its compiled code into the image** (no source mount), so
code changes require an image rebuild (see [§6](#6-buildingdeploying)).

---

## 2. Where your data lives

**All persistent data is under a single directory**, bind-mounted into the
containers:

```
docker/data/
├── postgres/   ← the financial database (accounts, transactions, budgets, …)
├── vault/      ← generated TLS cert + JWT secret
├── redis/      ← cache (safe to lose)
└── ollama/     ← downloaded AI models (re-downloadable)
```

This directory is set by the **`VAULT_DISK`** variable (default `./data`,
i.e. `docker/data`). It is **gitignored** — your data is never committed.

### Moving everything to a dedicated / separate drive

1. Mount the drive at the OS level (e.g. `/mnt/vault`) and make sure it's
   writable.
2. Stop the stack: `docker compose -f docker/docker-compose.yml down`
3. Move the data: `mv docker/data/* /mnt/vault/`
4. Point the stack at it and start:
   ```bash
   VAULT_DISK=/mnt/vault docker compose -f docker/docker-compose.yml up -d
   ```
   (Put `VAULT_DISK=/mnt/vault` in a `.env` file next to the compose file to
   make it permanent.)

> The data was migrated here from Docker **named volumes**. Those old volumes
> (`vault-finance_pgdata`, `_vaultdata`, `_redisdata`, `_ollamadata`) are still
> present as a rollback. Once you've confirmed everything works, reclaim the
> space: `docker volume rm vault-finance_pgdata vault-finance_vaultdata vault-finance_redisdata vault-finance_ollamadata`

---

## 3. Access control — who can get in

- **Single owner.** Setup creates exactly one owner account. There is **no
  registration, invite, or member-creation endpoint** — nobody else can make an
  account on your server.
- **Passwords** are hashed with **argon2id**; failed logins are constant-time so
  they can't reveal which accounts exist.
- **Sessions** use short-lived JWT access tokens plus refresh tokens stored only
  as hashes, rotated on every refresh and individually revocable
  (Settings → *Devices signed in*).
- **Login is rate-limited** (10 attempts / 15 min per identifier).
- **Transport** is TLS; the desktop app **pins the server's certificate
  fingerprint** on first connect.
- **Network reach:** the server is published on your **LAN** (`0.0.0.0:8443`).
  To restrict it to only this machine, change the port mapping in the compose
  file to `127.0.0.1:8443:8443` and restart — the local desktop app (which uses
  `localhost`) keeps working; other devices lose access.

---

## 4. Two-factor authentication (TOTP)

Off by default. Turn it on in **Settings → Two-factor authentication → Set up**:

1. Add the shown **setup key** (or otpauth link) to an authenticator app
   (Google Authenticator, Authy, 1Password, …).
2. Enter the current 6-digit code to confirm.

After that, signing in asks for your **password + a 6-digit code**. Turning 2FA
off requires your **account password**.

### Locked out? (lost your authenticator)

Because you own the server, you have an escape hatch — disable 2FA directly in
the database:

```bash
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U vault -d vault -c "update users set totp_enabled=false, totp_secret=null;"
```

Then sign in with just your password and re-enroll.

---

## 5. Backups

Your important data is Postgres. Two options:

**A. Logical dump (works while running — recommended for regular backups):**

```bash
docker compose -f docker/docker-compose.yml exec -T postgres \
  pg_dump -U vault vault > vault-backup-$(date +%F).sql
```

Restore into a fresh DB with `psql -U vault -d vault < vault-backup-YYYY-MM-DD.sql`.

**B. Cold copy (stop first, copy the whole data dir):**

```bash
docker compose -f docker/docker-compose.yml down
cp -a docker/data /path/to/backup/vault-data-$(date +%F)
docker compose -f docker/docker-compose.yml up -d
```

Also back up **`docker/data/vault/`** (the TLS cert + JWT secret) if you want
sign-ins and the client's pinned fingerprint to survive a full restore without
re-pinning / re-login.

> **Encryption at rest:** for maximum security, put `docker/data` (or the whole
> drive) on a LUKS-encrypted volume. That's an OS-level step done outside this
> app.

---

## 6. Building / deploying

Node/pnpm live at `~/.local/node/bin` (not on the default PATH):

```bash
export PATH="$HOME/.local/node/bin:$PATH"
```

**Server — updating to a new release:**

```bash
bash installers/server/update-server.sh
# equivalently, by hand:
docker compose -f docker/docker-compose.yml pull && \
docker compose -f docker/docker-compose.yml up -d      # migrations run on boot
```

The compose file runs a prebuilt image (`ghcr.io/nomad9021/vault-finance-server`,
tag from `VAULT_VERSION`, default `latest`). Each server also checks once a day
and, when SMTP is configured, emails the owner that an update is out. To build
from source instead, swap `image:` for the `build:` block in
`docker/docker-compose.yml` and `build server` as before.

**Multi-family host:** `docker/multi/familyctl.sh update --all` (pull + recreate
every family). The optional **admin control-plane** container is the only one
with the Docker socket — it wraps `familyctl.sh` for the desktop app's *Server
administration* window. Start it with `CONTROL=1 ./familyctl.sh up`, which
generates `docker/multi/control.token`. Treat that token like a root password:
anything holding it can create or destroy any family on the host.

**Desktop app (after changing client code):**

```bash
cd apps/desktop && pnpm tauri build
# then replace the copy you launch, e.g.:
cp "src-tauri/target/release/bundle/appimage/Vault Finance_0.1.0_amd64.AppImage" \
   ~/Applications/VaultFinance.AppImage
```

Closing the window does **not** quit the Tauri app — fully quit it before
relaunching so the new build loads. The `TAURI_SIGNING_PRIVATE_KEY` error at the
end of a build is only the auto-updater signing step; the app itself is built.

---

## 7. Health & troubleshooting

- **Is the server up?** `curl -sk -o /dev/null -w "%{http_code}\n" https://localhost:8443/api/v1/health`
- **Logs:** `docker compose -f docker/docker-compose.yml logs -f server`
- **The container reports "unhealthy":** known cosmetic quirk — its healthcheck
  probe doesn't handle the self-signed HTTPS. The server still responds.
- **Row counts (sanity check):**
  ```bash
  docker compose -f docker/docker-compose.yml exec -T postgres \
    psql -U vault -d vault -c "select count(*) from transactions;"
  ```

See also [self-hosting.md](self-hosting.md) for first-time setup and hardware
sizing.
