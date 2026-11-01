#!/usr/bin/env bash
#
# Vault Finance — passphrase-locked storage (Linux).
#
# Puts everything the server keeps — the database, its keys, receipts, AI
# memory — inside one LUKS2-encrypted volume. While it's locked, nobody can
# read any of it: not someone who takes the disk, not another account on this
# machine, not you without the passphrase. After every reboot the server stays
# down until you unlock it.
#
#   bash installers/server/vault-storage.sh create [--size 20G] [--image PATH]
#   bash installers/server/vault-storage.sh unlock    # asks for the passphrase, starts the server
#   bash installers/server/vault-storage.sh lock      # stops the server, seals the data
#   bash installers/server/vault-storage.sh status
#
# `create` moves an existing install's data into the encrypted volume. The
# volume is an ordinary file (default /var/lib/vault-finance/vault.img), so no
# disk is repartitioned. There is no way to recover the data without the
# passphrase — keep it in your password manager.
#
# Note: while UNLOCKED, the data is readable by root (and anyone in the docker
# group) on this machine, as it must be for the server to use it. Lock it, or
# keep the machine's admin accounts to yourself.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/../.." &>/dev/null && pwd)"
COMPOSE_DIR="$REPO_DIR/docker"
# Just two paths, nothing secret — readable so the installer can see it.
CONF="${VAULT_STORAGE_CONF:-/etc/vault-finance-storage.conf}"
MAPPER=vault-finance

if [ -t 1 ]; then B=$'\033[1m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RED=$'\033[31m'; RST=$'\033[0m'; else B= GRN= YLW= RED= RST=; fi
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '%s!%s %s\n' "$YLW" "$RST" "$*"; }
die()  { printf '%s✗ %s%s\n' "$RED" "$*" "$RST" >&2; exit 1; }

SUDO=""; [ "$(id -u)" = 0 ] || SUDO=sudo
DC="docker compose"

envget() { sed -n "s/^$1=//p" "$COMPOSE_DIR/.env" 2>/dev/null | tail -1; }

# The folder the stack keeps its data in (VAULT_DISK), as an absolute path.
vault_disk() {
  local d="${MOUNT:-$(envget VAULT_DISK)}"; d="${d:-$COMPOSE_DIR/data}"
  case "$d" in /*) ;; *) d="$COMPOSE_DIR/${d#./}" ;; esac
  printf '%s' "${d%/}"
}

load_conf() {
  $SUDO test -f "$CONF" || die "No encrypted storage set up yet. Run: bash $0 create"
  IMAGE="$($SUDO sed -n 's/^IMAGE=//p' "$CONF")"
  MOUNT="$($SUDO sed -n 's/^MOUNT=//p' "$CONF")"
  [ -n "$IMAGE" ] && [ -n "$MOUNT" ] || die "$CONF is incomplete"
}

is_open()    { [ -e "/dev/mapper/$MAPPER" ]; }
is_mounted() { mountpoint -q "$MOUNT" 2>/dev/null; }

stack() { ( cd "$COMPOSE_DIR" && $DC "$@" ); }

cmd_status() {
  load_conf
  if is_mounted; then ok "Unlocked — $MOUNT is mounted from $IMAGE"
  else say "${B}Locked${RST} — the data in $IMAGE can't be read. Unlock with: bash $0 unlock"; fi
}

cmd_unlock() {
  load_conf
  if is_mounted; then ok "Already unlocked."; else
    is_open || $SUDO cryptsetup open "$IMAGE" "$MAPPER" || die "Wrong passphrase, or the volume couldn't be opened."
    $SUDO mkdir -p "$MOUNT"
    $SUDO mount -o nodev,nosuid "/dev/mapper/$MAPPER" "$MOUNT" || { $SUDO cryptsetup close "$MAPPER"; die "Couldn't mount the volume."; }
    ok "Unlocked: $MOUNT"
  fi
  [ -f "$COMPOSE_DIR/.env" ] || { warn "No docker/.env yet — run the installer to start the server."; return 0; }
  stack up -d && ok "Server started."
}

cmd_lock() {
  load_conf
  if [ -f "$COMPOSE_DIR/.env" ]; then stack stop || warn "Couldn't stop every container — locking anyway."; fi
  if is_mounted; then $SUDO umount "$MOUNT" || die "Something is still using $MOUNT (check: sudo fuser -vm $MOUNT)"; fi
  if is_open; then $SUDO cryptsetup close "$MAPPER"; fi
  ok "Locked. The server is stopped and its data is sealed until you unlock it."
}

# A failed copy puts everything back as it was, so the stack never sees an
# empty volume and `create` can simply be run again.
undo_migration() {
  $SUDO umount "$MOUNT"
  $SUDO cryptsetup close "$MAPPER"
  $SUDO rmdir "$MOUNT"
  $SUDO mv "$2" "$MOUNT"
  $SUDO rm -f "$1"
  if [ -f "$COMPOSE_DIR/.env" ]; then stack up -d || warn "Couldn't restart the server."; fi
  die "$3 Your data is back in $MOUNT, unencrypted, and nothing was changed."
}

cmd_create() {
  local size="20G" image="/var/lib/vault-finance/vault.img"
  while [ $# -gt 0 ]; do
    case "$1" in
      --size)  size="$2"; shift 2 ;;
      --image) image="$2"; shift 2 ;;
      --mount) MOUNT="$2"; shift 2 ;;
      *) die "unknown option: $1" ;;
    esac
  done
  [[ "$size" =~ ^[0-9]+[MGT]$ ]] || die "--size must look like 20G"
  case "$image" in /*) ;; *) die "--image must be an absolute path" ;; esac

  command -v cryptsetup >/dev/null || die "cryptsetup not found. Install it: sudo apt-get install cryptsetup  (Fedora: dnf install cryptsetup)"
  command -v mkfs.ext4 >/dev/null || die "mkfs.ext4 not found (e2fsprogs)."
  $SUDO test -f "$CONF" && die "Encrypted storage already exists ($CONF). Use unlock / lock."

  MOUNT="$(vault_disk)"
  $SUDO test -e "$image" && die "$image already exists — refusing to overwrite it."

  say "${B}Encrypted storage for Vault Finance${RST}"
  say "  Volume file : $image ($size)"
  say "  Data folder : $MOUNT"
  say
  say "You'll choose a passphrase now. It is the ONLY way to open your data —"
  say "if it's lost, so is everything in the vault. Save it in a password manager."
  say

  local migrate=0
  if [ -d "$MOUNT" ] && [ -n "$(ls -A "$MOUNT" 2>/dev/null)" ]; then
    migrate=1
    warn "$MOUNT already has data. It will be stopped, copied into the encrypted volume, and the unencrypted copy removed."
  fi
  read -r -p "Continue? [y/N] " r; [[ "$r" =~ ^[Yy] ]] || die "Aborted — nothing changed."

  if [ "$migrate" = 1 ] && [ -f "$COMPOSE_DIR/.env" ]; then stack stop || true; fi

  $SUDO install -d -m 700 "$(dirname "$image")"
  $SUDO fallocate -l "$size" "$image" 2>/dev/null || $SUDO truncate -s "$size" "$image"
  $SUDO chmod 600 "$image"
  # argon2id makes each passphrase guess expensive for anyone with the file.
  $SUDO cryptsetup luksFormat --type luks2 --pbkdf argon2id --verify-passphrase "$image" \
    || { $SUDO rm -f "$image"; die "Couldn't create the encrypted volume."; }
  say "Enter the passphrase once more to open the new volume:"
  $SUDO cryptsetup open "$image" "$MAPPER" || die "Couldn't open the new volume."
  $SUDO mkfs.ext4 -q -L vault-finance "/dev/mapper/$MAPPER"

  local staged=""
  if [ "$migrate" = 1 ]; then
    staged="$MOUNT.unencrypted-$(date +%s)"
    $SUDO mv "$MOUNT" "$staged"
  fi
  $SUDO mkdir -p "$MOUNT"
  $SUDO mount -o nodev,nosuid "/dev/mapper/$MAPPER" "$MOUNT"
  $SUDO rmdir "$MOUNT/lost+found" 2>/dev/null || true

  if [ -n "$staged" ]; then
    say "Copying your data into the encrypted volume…"
    $SUDO cp -a "$staged/." "$MOUNT/" || undo_migration "$image" "$staged" "The copy failed (is the volume big enough? Use --size)."
    $SUDO diff -rq "$staged" "$MOUNT" >/dev/null || undo_migration "$image" "$staged" "The copy didn't match the original."
    $SUDO rm -rf "$staged"
    ok "Moved your data in and removed the unencrypted copy."
    warn "Deleted files can linger on a disk. For full certainty, also wipe that disk's free space (or the old disk)."
  fi
  # Every folder the stack mounts must exist (compose won't create them), and
  # the data ones are private whatever their permissions were before. New ones
  # are yours for now; the installer hands vault/ to the server container's
  # user, and Postgres/Redis take ownership of their own folders on first start.
  local d
  for d in postgres vault redis ollama update; do
    if ! $SUDO test -d "$MOUNT/$d"; then
      $SUDO mkdir "$MOUNT/$d"
      $SUDO chown "$(id -u):$(id -g)" "$MOUNT/$d"
    fi
  done
  $SUDO chmod 700 "$MOUNT"/{postgres,vault,redis,ollama}
  # Other accounts may pass through to the folders Docker mounts, but can't
  # list or read anything here.
  $SUDO chown root:root "$MOUNT"; $SUDO chmod 711 "$MOUNT"

  printf 'IMAGE=%s\nMOUNT=%s\n' "$image" "$MOUNT" | $SUDO tee "$CONF" >/dev/null
  $SUDO chmod 644 "$CONF"

  ok "Encrypted storage ready and unlocked at $MOUNT"
  say
  say "After every restart of this machine the server stays off until you run:"
  say "  ${B}bash $0 unlock${RST}"
  say "To seal it again by hand:  bash $0 lock"
  say "Back up the volume's header too (it can't be recreated if damaged):"
  say "  sudo cryptsetup luksHeaderBackup $image --header-backup-file <somewhere-safe>"
  if [ "$migrate" = 1 ] && [ -f "$COMPOSE_DIR/.env" ]; then stack up -d && ok "Server started again."; fi
}

case "${1:-}" in
  create) shift; cmd_create "$@" ;;
  unlock) cmd_unlock ;;
  lock)   cmd_lock ;;
  status) cmd_status ;;
  *) grep '^#' "$0" | sed 's/^# \{0,1\}//' | sed '1d'; exit 2 ;;
esac
