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
- **New devices must be approved** before they can sign in, even with the
  right password — see [§3a](#3a-device-approval--the-server-lets-you-in).
- **Transport** is TLS; the desktop app **pins the server's certificate
  fingerprint** on first connect.
- **Network reach:** the server is published on your **LAN** (`0.0.0.0:8443`).
  To restrict it to only this machine, change the port mapping in the compose
  file to `127.0.0.1:8443:8443` and restart — the local desktop app (which uses
  `localhost`) keeps working; other devices lose access.

### 3a. Device approval — the server lets you in

A correct password isn't enough on its own: every computer or phone has to be
**approved** the first time it signs in ([ADR-0009](adr/0009-device-approval.md)).
Each install keeps its own device identity for your server (in the OS
keychain), so this happens once per device — reinstalling the app or signing
in from a new phone counts as a new device.

When a new device signs in, it shows a **6-digit code** and waits. Approve it
either way the owner allows (Settings → *Approved devices*):

- **From a device that's already approved** — a *New sign-in waiting for
  approval* prompt appears; type the code shown on the new device and choose
  **Allow**. If you didn't just try to sign in somewhere, choose **Deny**.
- **On the server:**

  ```bash
  docker compose -f docker/docker-compose.yml exec server vault pending        # waiting requests + codes
  docker compose -f docker/docker-compose.yml exec server vault approve 482913
  docker compose -f docker/docker-compose.yml exec server vault deny 482913
  docker compose -f docker/docker-compose.yml exec server vault devices        # approved devices
  docker compose -f docker/docker-compose.yml exec server vault revoke <id>    # remove one, sign it out
  docker compose -f docker/docker-compose.yml exec server vault methods device=on console=on
  ```

The approved device then finishes signing in by itself. Codes last 15
minutes. Remove a lost device in Settings → *Approved devices* (or `vault
revoke`); it's signed out immediately and would need approval again.

**Upgrading doesn't lock anyone out:** devices that were signed in keep
working and are recorded as approved, and on a brand-new server the owner's
first device is approved automatically.

**Locked out of every device?** On the server, `vault pending` then `vault
approve <code> --override` — `--override` works even if console approval is
turned off.

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

Use the backup script. Every backup is a single file, **encrypted with AES-256
before it's written**: the database plus the server's data folder (TLS
certificate, data key, token-signing secret).

```bash
bash installers/server/backup-server.sh                  # one backup now
bash installers/server/backup-server.sh --install-timer  # plus every day at 03:00
```

- Backups go to `~/vault-backups` (`BACKUP_DIR`) and are **deleted after 30
  days** (`BACKUP_KEEP_DAYS`).
- The first run creates a random passphrase in
  `/etc/vault-finance/backup-passphrase` and prints it. **Save it in your
  password manager.** Without it the backups can't be opened, by you or anyone.
- Copy backups somewhere off this machine (another disk, another server). They're
  safe to store anywhere because they're encrypted.

Never run a bare `pg_dump > file.sql` for backups: that writes your financial
data to disk unencrypted.

**Restore** (onto a fresh install, stack stopped except Postgres):

```bash
gpg -d vault-2026-10-19-0300.tar.gpg | tar -xf -     # asks for the passphrase
cd docker && docker compose up -d postgres
docker compose exec -T postgres psql -U vault -d vault < ../database.sql
sudo tar -C data -xf ../server-data.tar               # TLS cert, keys, JWT secret
docker compose up -d
shred -u ../database.sql ../server-data.tar           # don't leave plaintext behind
```

> **Encryption at rest.** Secrets inside the database (2FA secrets, bank tokens,
> API keys) are always encrypted with the data key. The rest of the live
> database (transactions, balances) is protected by the disk it sits on, so run
> the server on an **encrypted disk**: choose "Encrypt the new Ubuntu
> installation" (LUKS) when installing Ubuntu, or keep the VM on encrypted
> Proxmox storage. The backup script warns when the data folder is on an
> unencrypted disk.

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

---

## 8. Rotating secrets

If a password, key or token is (or might have been) exposed, change it
**immediately**. Work down whichever rows apply:

| What was exposed | Do this |
| --- | --- |
| A member's password | Change it in **Settings → Account** (or the owner resets it). Then `vault sign-out-everyone`. |
| A device or refresh token (lost laptop, stolen phone) | **Settings → Devices** → revoke it, or `vault sign-out-everyone`. |
| The token-signing secret (`data/vault/jwt-secret`) | `vault rotate-jwt-secret`, then restart the server. |
| The data key (`data/vault/data-key`) or a backup + its passphrase | Rotate the data key (below), then also rotate every secret it protected: re-enroll 2FA, new Plaid secret, new AI key. |
| Plaid secret | Rotate it in the Plaid dashboard, paste the new one in **Settings → Bank**. |
| AI provider key / gateway key | Revoke it at the provider (or in the AI server's `.env`), paste the new one in **Settings → AI**. |
| SMTP password, Proxmox token, Postgres password | Change it at the source, update `docker/.env`, `docker compose up -d`. |

Rotating the data key re-encrypts every stored secret. Stop the server first, so
nothing is written with the old key while it runs:

```bash
cd docker
docker compose stop server
docker compose run --rm --no-deps server vault rotate-data-key
docker compose start server
```

Then make a new backup. Backups made before the rotation still open with the
old key inside them, so delete the ones that might have been exposed.
