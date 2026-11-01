#!/usr/bin/env bash
#
# Vault Finance — let the owner update the server from the app
# (Settings → Server update). Run once on the server, as the user that owns
# this checkout (it asks for sudo to install two systemd units):
#
#   bash installers/server/enable-app-updates.sh
#   bash installers/server/enable-app-updates.sh --disable
#
# How it works: the server container gets a small shared folder
# (data/update → /update). When the owner presses Update, the server writes
# request.json there. vault-update.path notices it and starts
# vault-update.service, which runs update-agent.sh → update-server.sh as you
# and reports progress in status.json. The container never gets Docker
# access. Single-family installs only; multi-family hosts use familyctl.sh.
#
# Also installs /usr/local/bin/vault-update (the command the app and the
# update emails point to) as a link to update-server.sh.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/../.." &>/dev/null && pwd)"
COMPOSE_DIR="$REPO_DIR/docker"
UNIT_DIR=/etc/systemd/system

if [ -t 1 ]; then B=$'\033[1m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RST=$'\033[0m'; else B= GRN= YLW= RST=; fi
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '%s!%s %s\n' "$YLW" "$RST" "$*"; }
die()  { printf '✗ %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "Run this as the user that owns $REPO_DIR, not as root (it uses sudo where needed)."
command -v systemctl >/dev/null || die "systemd not found — in-app updates need it. Use vault-update by hand instead."
command -v docker >/dev/null && docker compose version >/dev/null 2>&1 || die "docker compose not found"
if [ -d "$COMPOSE_DIR/multi/families" ] && compgen -G "$COMPOSE_DIR/multi/families/*/family.env" >/dev/null; then
  die "This is a multi-family host — update families with docker/multi/familyctl.sh instead."
fi

ME="$(id -un)"
DC="docker compose -f $COMPOSE_DIR/docker-compose.yml"

# Data root: VAULT_DISK from docker/.env, relative to docker/ like compose does.
VAULT_DISK="$(grep -E '^VAULT_DISK=' "$COMPOSE_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
VAULT_DISK="${VAULT_DISK:-./data}"
case "$VAULT_DISK" in /*) DATA_ROOT="$VAULT_DISK" ;; *) DATA_ROOT="$COMPOSE_DIR/${VAULT_DISK#./}" ;; esac
UPDATE_DIR="$DATA_ROOT/update"

if [ "${1:-}" = "--disable" ]; then
  sudo systemctl disable --now vault-update.path 2>/dev/null || true
  sudo rm -f "$UNIT_DIR/vault-update.path" "$UNIT_DIR/vault-update.service"
  sudo systemctl daemon-reload
  rm -f "$UPDATE_DIR/agent.json" "$UPDATE_DIR/request.json"
  ok "In-app updates turned off. vault-update still works by hand."
  exit 0
fi

grep -q '/update' "$COMPOSE_DIR/docker-compose.yml" \
  || die "docker/docker-compose.yml has no /update mount — update this checkout first (git pull on main)."

branch="$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [ -n "$branch" ] && [ "$branch" != "main" ]; then
  warn "This checkout is on '$branch', not main — updates will pull that branch. Switch with: git -C $REPO_DIR switch main"
fi

say "${B}Setting up in-app server updates${RST} (you may be asked for your sudo password)"

# The shared folder: you own it, the container's vault group can write to it.
VAULT_GID="$($DC run --rm --no-deps --entrypoint id server -g vault 2>/dev/null | tr -dc '0-9')"
[ -n "$VAULT_GID" ] || die "Couldn't read the server image's vault group. Is the image pulled? Try: $DC pull server"
sudo mkdir -p "$UPDATE_DIR"
sudo chown "$ME:$VAULT_GID" "$UPDATE_DIR"
# setgid keeps new files in the vault group; sticky stops the container
# deleting or swapping files the agent writes there (update-agent.sh).
sudo chmod 3770 "$UPDATE_DIR"
# Fresh temp file + rename, never a write through whatever is at agent.json:
# the container can create names in this folder (see update-agent.sh).
tmp="$(mktemp "$UPDATE_DIR/.agent.XXXXXXXX")"
printf '{"agent":1,"installedAt":"%s"}\n' "$(date -u +%FT%TZ)" >"$tmp"
chmod 644 "$tmp"
mv -fT "$tmp" "$UPDATE_DIR/agent.json"
ok "Shared folder: $UPDATE_DIR"

sudo tee "$UNIT_DIR/vault-update.service" >/dev/null <<EOF
[Unit]
Description=Vault Finance server update requested from the app
After=docker.service

[Service]
Type=oneshot
User=$ME
Environment=VAULT_UPDATE_DIR=$UPDATE_DIR
ExecStart=/usr/bin/env bash $SCRIPT_DIR/update-agent.sh
TimeoutStartSec=45min
EOF

sudo tee "$UNIT_DIR/vault-update.path" >/dev/null <<EOF
[Unit]
Description=Watch for Vault Finance update requests from the app

[Path]
PathExists=$UPDATE_DIR/request.json
Unit=vault-update.service

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now vault-update.path >/dev/null
ok "vault-update.path is watching for requests"

sudo ln -sf "$SCRIPT_DIR/update-server.sh" /usr/local/bin/vault-update
ok "vault-update command installed"

# Recreate the server so it picks up the /update mount.
$DC up -d server >/dev/null
ok "Server restarted with the shared folder"

say ""
say "Done. In the app (signed in as the owner): ${B}Settings → Server update → Update server${RST}."
say "Turn it off again with: bash installers/server/enable-app-updates.sh --disable"
