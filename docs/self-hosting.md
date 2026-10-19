# Self-hosting guide

Vault Finance is a client–server system where **you run the server**: all
financial data, uploads, and AI processing stay on your own hardware. There is
no cloud component. This guide covers deploying the server with Docker
Compose.

> Sections marked *(coming with M-x)* describe functionality from a later
> milestone in [roadmap.md](roadmap.md) and will be filled in when it lands.

## 1. Requirements

- **Docker** with the Compose plugin (Docker Engine 24+ recommended).
- **A machine that stays on** — a home server, NAS, mini-PC, or spare desktop.
  This is a server other devices connect to, not a one-off script.
- **Disk**: ~1 GB for the app + Postgres to start (grows with your data), plus
  **4–20 GB per AI model** if you run the bundled Ollama.
- **RAM**: 2 GB is plenty for the finance stack itself. Add what your chosen
  AI model needs (see [§6](#6-hardware-sizing-for-ollama)).

## 2. Quick start

### Easiest: the guided installer

Clone the repo, then run the installer for your OS. It asks where to store
your data, which port to use, whether to enable local AI, and (optionally)
creates your owner account — then writes `docker/.env` and starts everything.

```bash
# Linux / macOS
git clone <your-fork-or-release-tarball> vault-finance
cd vault-finance
bash installers/server/install-server.sh
```

```powershell
# Windows (Docker Desktop + PowerShell)
git clone <your-fork-or-release-tarball> vault-finance
cd vault-finance
pwsh -File installers\server\install-server.ps1
```

Re-running the installer is safe — it reads your existing answers as defaults.
Pass `--dry-run` (`-DryRun` on Windows) to preview the config without touching
Docker.

### Manual alternative

If you'd rather configure by hand:

```bash
git clone <your-fork-or-release-tarball> vault-finance
cd vault-finance/docker
cp .env.example .env        # defaults work; edit if you want
docker compose up -d
```

First boot does everything automatically:

1. Postgres initializes and the server runs all database migrations.
2. A self-signed TLS certificate and a JWT signing secret are generated into
   the `vaultdata` volume (they persist across restarts and upgrades).
3. The API comes up at `https://<server-ip>:8443`.

Check it:

```bash
curl -k https://localhost:8443/api/v1/setup/status
# → {"needsSetup":true}
```

Then open the desktop app, enter the server address, and the app walks you
through the **setup wizard** (owner account + AI configuration). Until the
desktop app milestone lands you can complete setup from a terminal:

```bash
curl -k -X POST https://localhost:8443/api/v1/setup/complete \
  -H 'content-type: application/json' \
  -d '{
    "ownerEmail": "you@example.com",
    "ownerPassword": "pick-a-long-passphrase",
    "ownerDisplayName": "Your Name"
  }'
```

The wizard refuses to run twice — after the owner account exists,
`setup/complete` returns `409 SETUP_ALREADY_COMPLETE`.

## 3. Configuring remote access

The desktop app asks for a **server address**. What you enter depends on how
you reach the machine:

| Scenario | Server address to enter |
|---|---|
| Same LAN | `https://192.168.x.x:8443` or `https://hostname.local:8443` |
| Tailscale / VPN | `https://<tailscale-ip-or-magicdns-name>:8443` |
| Reverse proxy with real TLS | whatever hostname the proxy serves |

**Tailscale** is the recommended way to use the app away from home: install
Tailscale on both the server and your devices, and use the server's Tailscale
IP (or MagicDNS name) as the server address. No ports are exposed to the
internet, and the app's own TLS still applies inside the tunnel.

The desktop app can **turn Tailscale on for you**: the connect screen shows a
*Turn on* button when Tailscale is installed but off, the startup check offers
it when the server can't be reached, and **Settings → Tailscale** has on/off
controls. If this device still needs to sign in, the app opens Tailscale's
sign-in page in your browser and carries on once you're connected. On Linux,
the first time it may ask for your password once to make your account the
Tailscale "operator" (`tailscale set --operator=$USER`) — after that no
password is needed.

Do **not** port-forward 8443 to the open internet. If you need
internet-without-VPN access, put a reverse proxy with a real certificate and
its own hardening in front, and understand what you're exposing.

## 4. TLS and certificate trust

The server always speaks HTTPS. By default it generates a **self-signed
certificate** on first boot ([ADR-0004](adr/0004-tls-trust.md)) and keeps it
stable from then on. Desktop clients use trust-on-first-use: the first
connection shows the certificate fingerprint, you confirm it, and the app
pins it — any later change is a hard warning, not a silent accept.

To use your own certificate instead (internal CA, or a wildcard you own),
mount the pair into the container and point the server at it:

```yaml
# docker-compose.yml, under server:
    environment:
      VAULT_TLS_CERT: /certs/server.crt
      VAULT_TLS_KEY: /certs/server.key
    volumes:
      - ./certs:/certs:ro
      - vaultdata:/data
```

`curl` note: `-k` skips verification, fine for spot checks on localhost. For
scripts, fetch the cert once and pass `--cacert` instead.

## 5. Email notifications (optional)

Set the `SMTP_*` values in `docker/.env` to let the server send:

- a **welcome / confirmation** email when the owner finishes setup;
- an **"update available"** email (once per new version) — the server checks
  the project's GitHub releases once a day;
- **household-member invitations** (Settings → Family members).

```bash
# docker/.env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=…
MAIL_FROM=Vault Finance <no-reply@example.com>
APP_PUBLIC_URL=https://192.168.1.10:8443   # used for links in emails
SURVEY_URL=https://forms.example.com/…      # optional, linked from the welcome email
```

With `SMTP_HOST` blank the server runs exactly as before — nothing is sent, and
member invites fall back to a copy-able one-time link shown in the app.

## 6. Family members

Everyone in a household shares the same accounts and transactions (this is a
family app, not multi-tenant — see [architecture.md](architecture.md)). The
**owner** adds people from **Settings → Family members**, either by emailing a
one-time invite link (they set their own password) or by creating the account
with a temporary password. Members can use every feature but can't manage other
members or change server-level settings.

## 7. AI setup (optional)

**The AI assistant is off by default.** The app is fully usable without it —
there's no assistant UI at all until you turn it on. To enable it, open
**Settings → AI** in the desktop app, pick a provider, and save. Four
providers are supported:

- **Ollama (local)** — runs a model on your own hardware; nothing leaves your
  server. The compose file bundles an Ollama service; point the base URL at
  `http://ollama:11434` (the default) or at another machine on your network.
  Pull a model once after first boot:
  ```bash
  docker compose exec ollama ollama pull llama3.1:8b
  ```
- **Other local AI (OpenAI-compatible)** — LM Studio, llama.cpp's
  `llama-server`, vLLM, LocalAI, Jan, text-generation-webui, or anything else
  that speaks the OpenAI API. Enter its address (usually ending in `/v1`).
  Nothing leaves your hardware.
- **OpenAI** — paste your OpenAI API key and a model (e.g. `gpt-4o-mini`).
- **Anthropic (Claude)** — paste your Anthropic API key and a model
  (e.g. `claude-sonnet-5`).

Your API key is stored on **your** server and is never shown again or sent to
anyone but the provider you chose.

> **Privacy note.** With **Ollama**, your financial data never leaves your
> hardware. With **OpenAI or Anthropic**, a short summary of your accounts,
> spending, and budgets is sent to that provider under your key each time you
> ask a question. The app shows this warning before you enable a cloud
> provider. Choose Ollama if you want everything to stay local.

**If the provider is unreachable, nothing else breaks.** Accounts,
transactions, budgets, reports — everything non-AI keeps working; the AI
surfaces simply stay hidden or show a clear "reconnect" state.

### Using a separate AI machine

The Vault server can hand AI work to **another computer** — typically a
desktop with a GPU — while your data stays on the Vault server. The Vault
server talks to the AI machine directly; the desktop app never does.

1. **On the AI machine**, make the AI server listen on the network, not just
   on localhost:
   - **Ollama:** set `OLLAMA_HOST=0.0.0.0` and restart Ollama
     (Linux: `sudo systemctl edit ollama` → `Environment="OLLAMA_HOST=0.0.0.0"`;
     Windows/macOS: set it as a user environment variable and restart the
     Ollama app). Then pull a model: `ollama pull llama3.1:8b`.
   - **LM Studio:** Developer → turn on *Serve on Local Network*.
   - **llama-server / vLLM:** start with `--host 0.0.0.0`.
2. Allow the port through that machine's firewall (Ollama `11434`,
   LM Studio `1234`) — ideally only from your LAN or Tailscale.
3. In **Settings → AI**, choose *Ollama* or *Other local AI*, enter the AI
   machine's address, and press **Test connection**:

   | Where the AI runs | Address to enter |
   |---|---|
   | Bundled Ollama container | `http://ollama:11434` |
   | Another computer on your LAN | `http://192.168.1.50:11434` (Ollama) or `http://192.168.1.50:1234/v1` |
   | Another computer on Tailscale | `http://100.x.y.z:11434` — the Vault server's host must be on Tailscale too |
   | The same computer as the Vault server, outside Docker | `http://host.docker.internal:11434` |

   Don't use `localhost` — inside Docker it means the Vault container itself.
   If the test fails, it says why in plain words (nothing listening, wrong
   path, firewall, needs a token…) and what to change.
4. Behind a reverse proxy that requires a login? Put the token in **Access
   token (optional)**; it's sent as a bearer token and stored only on your
   Vault server.

Using a separate AI machine? You can drop the `ollama` service from the
compose file entirely — the app doesn't need it unless you point Ollama at it.

## 8. Hardware sizing for Ollama

*(numbers to be measured and filled in during M4 — placeholder guidance:)*

| Model class | RAM (CPU-only) | VRAM (GPU) | Feel |
|---|---|---|---|
| 3B (e.g. `llama3.2:3b`) | 8 GB | 4 GB | fast, good for summaries |
| 7–8B (e.g. `llama3.1:8b`) | 16 GB | 8 GB | recommended default |
| 13–14B | 32 GB | 12–16 GB | noticeably better reasoning |
| 30B+ | 64 GB+ | 24 GB+ | best quality, needs real hardware |

CPU-only works — responses stream slower but the app is fully usable.

For a quick smoke test that the pipeline works before committing to a big
download, `ollama pull llama3.2:1b` (~1.3 GB) streams fine on any hardware —
just don't judge answer quality by it; small models quote your numbers
correctly but reason clumsily about them.

## 9. Backups

Back up with the encrypted backup script. Each backup is one AES-256-encrypted
file holding the database and the server's data folder, kept 30 days:

```bash
bash installers/server/backup-server.sh                  # one backup now
bash installers/server/backup-server.sh --install-timer  # plus daily at 03:00
```

Save the passphrase it prints in your password manager, and copy backups off
the machine. Restoring, and why not to use a plain `pg_dump`, are covered in
[operations §5](operations.md#5-backups).

## 10. Updating

**Server** — pull the new prebuilt image and restart; migrations run
automatically on boot:

```bash
bash installers/server/update-server.sh
# or by hand:
docker compose -f docker/docker-compose.yml pull
docker compose -f docker/docker-compose.yml up -d
```

The compose file runs `ghcr.io/nomad9021/vault-finance-server` (tag from
`VAULT_VERSION`, default `latest`). Each server checks the project's GitHub
releases once a day and — when SMTP is set — emails the owner when a new
version ships. Prefer building from source? Swap `image:` for the commented
`build:` block and `docker compose up -d --build`.

**Desktop apps** — built-in auto-updater. Server and
clients share one semantic version line; if a client is older than the
server's `minClientVersion`, the API answers `426` and the app shows an
"update required" screen instead of failing in confusing ways. Updating the
server first is always the safe order.

## 11. Troubleshooting

**Start with the app's own check.** Every time it opens, the desktop app runs a
system check — this computer, Tailscale, reaching the server, the server's
identity, app/server versions, the database, free disk space, and (once
signed in) the AI provider, bank sync and server updates. If something's
wrong it stops on that screen and says what to do; **Settings → System
status** runs the same checks any time.

- **Installer: "Docker daemon isn't running"** — `sudo systemctl enable --now docker`
  (the installer offers to run it). `enable` also starts Docker on boot.
- **Installer: "can't talk to Docker" / `permission denied … docker.sock`** —
  your user isn't in the `docker` group: `sudo usermod -aG docker $USER`, then
  `newgrp docker` or log out and back in. Group changes don't reach terminals
  that were already open, so "I added myself and it still fails" means re-login.
- **`cd: vault-finance: No such file or directory`** — you're already inside
  the repo; run `bash installers/server/install-server.sh` without the `cd`.
- **Port already in use** — change `VAULT_PORT` in `.env` (host side only;
  the container keeps listening on 8443 internally).
- **`needsSetup` is still true after setup** — you're probably talking to a
  different server/volume than you think. `docker compose logs server` shows
  the database it connected to.
- **Certificate warning after redeploy** — if you deleted the `vaultdata`
  volume, a new cert was generated and clients that pinned the old
  fingerprint will (correctly) warn. Re-confirm the new fingerprint.
- **AI shows offline** — Settings → AI shows the reason under the status
  line. For the bundled Ollama: `docker compose logs ollama` and confirm a
  model is pulled (`docker compose exec ollama ollama list`). For a separate
  AI machine, see [Using a separate AI machine](#using-a-separate-ai-machine).
- **Login rate-limited (429)** — 10 attempts per 15 minutes per device+email.
  Wait, or restart the server to clear it.

## 12. Hosting more than one family

One stack serves **one family** — every member sees all of its data. To host
several unrelated families on the same machine with their data fully separate,
run one isolated instance per family with `docker/multi/familyctl.sh`. See
[multi-family.md](multi-family.md).

## 13. Manual release steps for maintainers

Moved to [releasing.md](releasing.md): cutting a release, the updater
signing key, and the one-time macOS notarization setup (browser + CI only —
no Mac required, per the project's constraints).

## 14. Linking real banks with Plaid (optional)

Bank linking is off by default, and the app works fully without it. With Plaid, your bank sign-in and
transactions go through Plaid's cloud under **your own** Plaid account. That's
the one part of Vault Finance that leaves your hardware, so the Settings screen
warns before you turn it on.

### 1. Get Plaid keys

1. Sign up at [dashboard.plaid.com](https://dashboard.plaid.com/signup). Turn on
   two-factor authentication for that account.
2. **Developers → Keys**: copy the **client ID**, plus the **Sandbox** secret and
   (once approved) the **Production** secret. Keep them in your password manager.
3. Production with real banks needs Plaid's approval: in the Dashboard, request
   Production access for **Transactions** and fill in the use-case description.
   Large banks that sign in through their own website (Chase, Bank of America,
   Wells Fargo, Capital One…) also need Plaid's **OAuth institution
   registration**, which Plaid finishes after Production approval. Check the
   Dashboard's **Billing** page for current pricing before you link banks.

### 2. Try it with Sandbox first

**Settings → Bank linking**: provider **Plaid**, environment **Sandbox**, your
client ID and Sandbox secret, tick **Enable bank linking**, **Save**, then
**Link a bank**. Plaid's sign-in page opens in your browser: pick any test bank
and sign in with `user_good` / `pass_good`. The app shows the new accounts when
you finish.

### 3. Switch to your real banks

Change the environment to **Production**, paste the Production secret, **Save**,
and **Link a bank** again. Sign in to your bank on Plaid's page. Repeat for each
bank.

- Up to 2 years of history is requested. Older transactions can take a few
  minutes to arrive; they come in with the next sync (automatic every hour, or
  press **Sync**).
- Pending charges show as "Pending" and are replaced by the posted transaction.
- **Needs you to sign in to the bank again**: the bank's password changed or
  its consent expired. Press **Reconnect** and sign in on Plaid's page.
- **Disconnect** also tells Plaid to drop its access to that bank. Accounts and
  history already imported stay in Vault.

Vault finds out you've finished by asking Plaid, so this works on a server
that's only reachable on your LAN or Tailscale. No public address or webhook is
needed.

Keys and tokens are encrypted at rest. If your Plaid secret might have leaked,
rotate it in the Plaid Dashboard and paste the new one in Settings
([operations §8](operations.md#8-rotating-secrets)).
