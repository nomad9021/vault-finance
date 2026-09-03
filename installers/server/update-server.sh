#!/usr/bin/env bash
#
# Vault Finance — one-command server update (Linux / macOS).
#
# Pulls the newest prebuilt image and restarts the stack. Your data (Postgres
# volume + /data) is untouched; database migrations run automatically on boot.
#
#   bash installers/server/update-server.sh            # this machine
#   curl -fsSL https://raw.githubusercontent.com/nomad9021/vault-finance/main/installers/server/update-server.sh | bash
#
# Handles both layouts:
#   - single-family  docker/docker-compose.yml
#   - multi-family   docker/multi/familyctl.sh   (updates every family)
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/../.." &>/dev/null && pwd)"
COMPOSE_FILE="$REPO_DIR/docker/docker-compose.yml"
MULTI_DIR="$REPO_DIR/docker/multi"

if [ -t 1 ]; then B=$'\033[1m'; GRN=$'\033[32m'; RST=$'\033[0m'; else B= GRN= RST=; fi
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$GRN" "$RST" "$*"; }
die()  { printf '✗ %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "docker not found"
docker compose version >/dev/null 2>&1 || die "docker compose plugin not found"

# Pull the repo itself forward too, so compose files / scripts stay in sync
# with the image. Skipped when this isn't a git checkout (e.g. release tarball).
if git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  say "${B}Updating repository…${RST}"
  git -C "$REPO_DIR" pull --ff-only || say "  (couldn't fast-forward — continuing with current checkout)"
fi

if [ -d "$MULTI_DIR/families" ] && compgen -G "$MULTI_DIR/families/*/family.env" >/dev/null; then
  say "${B}Multi-family host — updating every family…${RST}"
  bash "$MULTI_DIR/familyctl.sh" update --all
  ok "all families updated"
else
  say "${B}Updating the Vault Finance stack…${RST}"
  docker compose -f "$COMPOSE_FILE" pull
  docker compose -f "$COMPOSE_FILE" up -d
  docker image prune -f >/dev/null 2>&1 || true
  ok "server updated — migrations run automatically on boot"
  say "  Check it came back up:  docker compose -f docker/docker-compose.yml ps"
fi
