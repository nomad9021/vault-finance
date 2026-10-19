#!/usr/bin/env bash
#
# Vault Finance — encrypted backup (Linux).
#
#   bash installers/server/backup-server.sh                 # make one backup now
#   bash installers/server/backup-server.sh --install-timer # also back up daily at 03:00
#
# Each backup is ONE file, encrypted with AES-256 (gpg) before it touches the
# disk: the database dump plus the server's data folder (TLS certificate, data
# key, token-signing secret). Nothing is written unencrypted except inside a
# private temporary folder that's wiped straight after.
#
# The passphrase lives in /etc/vault-finance/backup-passphrase (root-only). It
# is created on the first run — copy it into your password manager: without it
# the backups can't be opened.
#
# Settings (environment):
#   BACKUP_DIR        where backups go           (default: ~/vault-backups)
#   BACKUP_KEEP_DAYS  delete backups older than  (default: 30)
#
# Restore: see docs/operations.md §5.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/../.." &>/dev/null && pwd)"
COMPOSE_DIR="$REPO_DIR/docker"
BACKUP_DIR="${BACKUP_DIR:-$HOME/vault-backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
PASS_FILE=/etc/vault-finance/backup-passphrase

if [ -t 1 ]; then B=$'\033[1m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RST=$'\033[0m'; else B= GRN= YLW= RST=; fi
ok()   { printf '%s✓%s %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '%s!%s %s\n' "$YLW" "$RST" "$*"; }
die()  { printf '✗ %s\n' "$*" >&2; exit 1; }

SUDO=""; [ "$(id -u)" = 0 ] || SUDO=sudo
command -v gpg >/dev/null || die "gpg not found (sudo apt-get install gnupg)"
[ -f "$COMPOSE_DIR/.env" ] || die "No $COMPOSE_DIR/.env — is the server installed here?"
envget() { sed -n "s/^$1=//p" "$COMPOSE_DIR/.env" | tail -1; }
DB_USER="$(envget POSTGRES_USER)"; DB_USER="${DB_USER:-vault}"
DB_NAME="$(envget POSTGRES_DB)"; DB_NAME="${DB_NAME:-vault}"
DISK="$(envget VAULT_DISK)"; DISK="${DISK:-./data}"
case "$DISK" in /*) ;; *) DISK="$COMPOSE_DIR/${DISK#./}" ;; esac

if [ "${1:-}" = "--install-timer" ]; then
  $SUDO tee /etc/systemd/system/vault-backup.service >/dev/null <<EOF
[Unit]
Description=Vault Finance encrypted backup
[Service]
Type=oneshot
User=$(id -un)
Environment=BACKUP_DIR=$BACKUP_DIR BACKUP_KEEP_DAYS=$KEEP_DAYS
ExecStart=/usr/bin/env bash $SCRIPT_DIR/backup-server.sh
EOF
  $SUDO tee /etc/systemd/system/vault-backup.timer >/dev/null <<'EOF'
[Unit]
Description=Daily Vault Finance backup
[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
[Install]
WantedBy=timers.target
EOF
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now vault-backup.timer >/dev/null
  ok "Daily backup at 03:00 into $BACKUP_DIR (kept $KEEP_DAYS days)"
fi

# ---- passphrase ----
if ! $SUDO test -s "$PASS_FILE"; then
  $SUDO install -d -m 700 "$(dirname "$PASS_FILE")"
  openssl rand -base64 32 | tr -d '\n' | $SUDO tee "$PASS_FILE" >/dev/null
  $SUDO chmod 600 "$PASS_FILE"
  warn "Created a backup passphrase. Save it in your password manager NOW — backups can't be opened without it:"
  printf '\n    %s%s%s\n\n' "$B" "$($SUDO cat "$PASS_FILE")" "$RST"
fi

# ---- dump + pack into a private temp dir, encrypt, wipe ----
umask 077
work="$(mktemp -d)"
trap '$SUDO rm -rf "$work"' EXIT
mkdir -p "$BACKUP_DIR"

(cd "$COMPOSE_DIR" && docker compose exec -T postgres pg_dump -U "$DB_USER" -d "$DB_NAME" --no-owner) > "$work/database.sql" \
  || die "pg_dump failed — is the stack running? (cd docker && docker compose ps)"
$SUDO tar -C "$DISK" -cf "$work/server-data.tar" vault
$SUDO chown "$(id -u):$(id -g)" "$work/server-data.tar"

out="$BACKUP_DIR/vault-$(date +%F-%H%M).tar.gpg"
tar -C "$work" -cf - database.sql server-data.tar \
  | $SUDO gpg --batch --yes --pinentry-mode loopback --passphrase-file "$PASS_FILE" \
      --symmetric --cipher-algo AES256 --compress-algo zlib -o "$out"
$SUDO chown "$(id -u):$(id -g)" "$out"
chmod 600 "$out"
ok "Encrypted backup: $out ($(du -h "$out" | cut -f1))"

# ---- retention ----
deleted=$(find "$BACKUP_DIR" -maxdepth 1 -name 'vault-*.tar.gpg' -mtime +"$KEEP_DAYS" -print -delete | wc -l)
[ "$deleted" -gt 0 ] && ok "Deleted $deleted backup(s) older than $KEEP_DAYS days"

# Data that sits on an unencrypted disk is only as safe as the disk.
src="$(findmnt -no SOURCE --target "$DISK" 2>/dev/null || true)"
if [ -n "$src" ] && ! lsblk -no TYPE "$src" 2>/dev/null | grep -q crypt && ! lsblk -s -no TYPE "$src" 2>/dev/null | grep -q crypt; then
  warn "The live data in $DISK is on an unencrypted disk. Use full-disk encryption on this VM (or encrypted Proxmox storage) — see docs/operations.md §5."
fi
exit 0
