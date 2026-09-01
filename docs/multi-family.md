# Hosting multiple families on one server

Vault Finance is a **single-family** app: inside one instance, every household
member can see every account and transaction (see
[architecture.md](architecture.md) and `accounts/routes.ts`). To host several
*unrelated* families on one machine with their data fully separate, you run
**one isolated instance per family** — separate server process, separate
database, separate secrets — sharing only the pieces that carry no family data.

`docker/multi/familyctl.sh` provisions and manages these instances. No
application code changes are involved; each family runs the same server image
you already build.

## What is isolated, what is shared

| Piece | Per family? | How families stay separate |
|---|---|---|
| Server container `vault-<slug>` | **yes** | own process, own config |
| Postgres **database + login role** `vault_<slug>` | **yes** | the role has no `CONNECT` privilege on any other family's database — verified below |
| `/data` volume `vault-fam-<slug>-data` | **yes** | own `jwt-secret` (a token from one family is rejected by every other), own `data-key` (column encryption), own self-signed TLS cert, own uploaded receipts |
| Postgres **server** | shared (one container) | ~0 extra RAM per family; isolation is the per-database role |
| Ollama | shared (one container) | the model is stateless; each family's AI provider + API key live in its own database |
| HAProxy (optional) | shared | TLS **passthrough** only — see below |

## First-time setup

```bash
cd docker/multi
./familyctl.sh build     # build vault-finance-server:multi from docker/Dockerfile.server
./familyctl.sh up        # start the shared Postgres + Ollama (project: vault-multi)
```

Shared data lives under `docker/multi/data/` by default. For a dedicated disk,
`export VAULT_MULTI_DISK=/mnt/drive/vault-multi` before `up`.

The existing single-family stack in `docker/docker-compose.yml` is a **different
compose project** and is left untouched — you can run both, or migrate the old
one in with `import-existing` (below).

## Adding a family

```bash
./familyctl.sh create smith
```

This creates the `vault_smith` database + role, a `/data` volume, renders
`families/smith/compose.yml`, starts `vault-smith`, waits for first-boot
migrations, and prints the address to hand the family:

```
Connect address for this family:  https://<server-ip>:8444
```

The family opens the desktop app, enters that address, confirms the certificate
fingerprint once, and completes the **owner-account wizard**. Nothing they do is
visible to any other family.

Ports are assigned from 8443 upward, skipping anything already in use.

### Reaching families: ports vs. subdomains

**Port per family (default).** Each family connects to `https://server:<port>`.
Zero extra infrastructure. Open one firewall port per family. Good up to a
handful of families, or when you use Tailscale/VPN anyway (recommended for
internet access — see [self-hosting.md §3](self-hosting.md)).

**Subdomains via HAProxy** (`--proxy`, add when you outgrow ports):

```bash
./familyctl.sh create jones --proxy --domain jones.vault.example.com
```

Requires a wildcard DNS record `*.vault.example.com` → this host and port 443
open. HAProxy reads the TLS server name and forwards the **raw** connection to
that family's server — it never decrypts. The family's own self-signed
certificate (and its pinned fingerprint) reaches the client unchanged, exactly
as in port mode. Rate-limiting still sees real client IPs.

Switching an existing deployment from ports to subdomains later: recreate each
family with `--proxy --domain …` (or edit `families/<slug>/family.env` and run
any `create`/`destroy` to regenerate `haproxy/haproxy.cfg`), then open 443.

## Day-to-day

```bash
./familyctl.sh list                       # slug, port, mode, container state, DB size
./familyctl.sh backup smith               # -> docker/multi/backups/smith-<ts>.{sql.gz,data.tar.gz}
./familyctl.sh restore smith <sql.gz> <data.tar.gz>
./familyctl.sh destroy smith              # archives DB + volume to backups/, then removes everything
```

### Updating

```bash
git pull
./familyctl.sh upgrade --all      # rebuilds the image, recreates every family container
# or: ./familyctl.sh upgrade smith
```

Migrations run automatically on each family's boot, per database. Update the
server before clients, as always.

## Migrating your current single-family stack in

```bash
# with the old `vault-finance` compose project still running:
./familyctl.sh import-existing smith
```

It dumps the old `vault` database into `vault_smith` and copies the old
`docker/data/vault` directory into the new family volume, so the existing JWT
secret and TLS certificate carry over — **pinned clients keep working and
sessions survive**. Verify the app against the new instance, then retire the old
stack (`docker compose -p vault-finance down`).

Override the source with `--from-project <name>` or `--from-file <dump.sql[.gz]>`.

## Verifying isolation

```bash
cd docker/multi
B(){ docker compose -p vault-multi -f docker-compose.base.yml exec -T postgres "$@"; }

# a family role cannot connect to another family's database
B psql -U vault_smith -d vault_jones -c 'select 1'
#   -> FATAL: permission denied for database "vault_jones"

# each instance has its own setup state / data
curl -sk https://localhost:8444/api/v1/setup/status   # {"needsSetup":...} independent per family

# a token minted by one family is rejected by another (different jwt-secret) -> 401
```

## Hardware sizing

- Shared, once: Postgres (~400 MB image, ~120 MB RAM) + Ollama (model-dependent,
  see [self-hosting.md §6](self-hosting.md)).
- Per family: ~120 MB RAM for the server container + database growth with their
  data. 10+ families on a 4 GB box is comfortable if Ollama is small or off.

## Files

```
docker/multi/
  docker-compose.base.yml      shared postgres + ollama + (optional) haproxy
  family.service.yml.tmpl      per-family server service, rendered by familyctl
  familyctl.sh                 the orchestrator
  haproxy/haproxy.cfg          generated; committed stub so the bind-mount is a file
  haproxy/families.map         generated SNI -> backend map
  families/<slug>/             rendered compose + family.env (secrets) + [gitignored]
  data/                        shared postgres/ollama state [gitignored]
  backups/                     backup + destroyed-family archives [gitignored]
```
