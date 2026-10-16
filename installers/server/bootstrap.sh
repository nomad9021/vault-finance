#!/usr/bin/env bash
#
# Vault Finance — one-line server bootstrap (Linux).
#
#   curl -fsSL https://raw.githubusercontent.com/nomad9021/vault-finance/main/installers/server/bootstrap.sh | bash
#
# Installs what the server needs (git, Docker Engine + Compose), clones (or
# updates) the repo, then hands off to installers/server/install-server.sh,
# which asks its usual questions. Safe to re-run.
#
# Pass installer flags after `-s --`:
#   curl -fsSL …/bootstrap.sh | bash -s -- --yes
#
# Environment overrides:
#   VF_DIR   where to clone the repo         (default: ~/vault-finance)
#   VF_REF   branch or tag to check out      (default: main)
#   VF_REPO  git URL                         (default: the GitHub repo)
#
set -euo pipefail

# Everything lives in main(), called on the last line, so a truncated download
# can't run half a script.
main() {
  local repo="${VF_REPO:-https://github.com/nomad9021/vault-finance.git}"
  local ref="${VF_REF:-main}"
  local dir="${VF_DIR:-$HOME/vault-finance}"

  if [ -t 1 ]; then B=$'\033[1m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RED=$'\033[31m'; RST=$'\033[0m'; else B= GRN= YLW= RED= RST=; fi
  hdr()  { printf '\n%s%s%s\n' "$B" "$*" "$RST"; }
  ok()   { printf '%s✓%s %s\n' "$GRN" "$RST" "$*"; }
  warn() { printf '%s!%s %s\n' "$YLW" "$RST" "$*"; }
  die()  { printf '%s✗ %s%s\n' "$RED" "$*" "$RST" >&2; exit 1; }

  hdr "Vault Finance server bootstrap"
  [ "$(uname -s)" = "Linux" ] || die "This bootstrap is for Linux. On macOS/Windows, clone the repo and run the installer for your platform (see README)."

  # Root runs commands directly; everyone else goes through sudo.
  SUDO=""
  if [ "$(id -u)" != "0" ]; then
    command -v sudo >/dev/null 2>&1 || die "Run this as root, or install sudo first."
    SUDO="sudo"
  fi

  # The installer asks questions. Under `curl | bash` stdin is the script
  # itself, so prompts must read from the terminal instead.
  local tty_in=""
  if [ -r /dev/tty ] && (: </dev/tty) 2>/dev/null; then tty_in="/dev/tty"; fi
  case " $* " in *" --yes "*|*" -y "*|*" --dry-run "*) ;; *)
    [ -n "$tty_in" ] || die "No terminal for the installer's questions. Re-run with: … | bash -s -- --yes" ;;
  esac

  # ---- git + curl ----
  local need=()
  command -v git  >/dev/null 2>&1 || need+=(git)
  command -v curl >/dev/null 2>&1 || need+=(curl)
  if [ "${#need[@]}" -gt 0 ]; then
    hdr "Installing ${need[*]}"
    if   command -v apt-get >/dev/null 2>&1; then $SUDO apt-get update -qq && $SUDO apt-get install -y -qq "${need[@]}" ca-certificates
    elif command -v dnf     >/dev/null 2>&1; then $SUDO dnf install -y -q "${need[@]}"
    elif command -v pacman  >/dev/null 2>&1; then $SUDO pacman -Sy --noconfirm --needed "${need[@]}"
    else die "Install ${need[*]} with your package manager, then re-run."
    fi
  fi
  ok "git and curl present"

  # ---- Docker Engine + Compose ----
  local have_docker=0
  if command -v docker >/dev/null 2>&1 && $SUDO docker compose version >/dev/null 2>&1; then have_docker=1; fi
  if [ "$have_docker" = "0" ]; then
    hdr "Installing Docker (official get.docker.com script)"
    curl -fsSL https://get.docker.com | $SUDO sh
  fi
  if command -v systemctl >/dev/null 2>&1; then
    $SUDO systemctl enable --now docker >/dev/null 2>&1 || warn "Couldn't enable the docker service; the installer will check again."
  fi
  ok "Docker $(docker --version 2>/dev/null | sed 's/^Docker version //; s/,.*//') installed"

  # Non-root users need the docker group. A fresh membership isn't active in
  # this shell, so the installer is run under `sg docker` below.
  local use_sg=0
  if [ -n "$SUDO" ] && ! docker info >/dev/null 2>&1; then
    local me; me="$(id -un)"
    if ! id -nG "$me" | grep -qw docker; then
      $SUDO usermod -aG docker "$me"
      ok "Added $me to the docker group (takes effect for new logins)"
    fi
    use_sg=1
  fi

  # ---- clone or update ----
  if [ -d "$dir/.git" ]; then
    hdr "Updating $dir"
    git -C "$dir" fetch --quiet origin "$ref"
    git -C "$dir" checkout --quiet "$ref"
    git -C "$dir" pull --quiet --ff-only origin "$ref" 2>/dev/null || warn "Couldn't fast-forward $dir (local changes?) — using it as is."
  elif [ -e "$dir" ]; then
    die "$dir exists but isn't a git checkout. Move it aside or set VF_DIR=/another/path."
  else
    hdr "Cloning into $dir"
    git clone --quiet --branch "$ref" "$repo" "$dir"
  fi
  ok "Repo ready at $dir ($(git -C "$dir" rev-parse --short HEAD))"

  # ---- hand off ----
  local installer="$dir/installers/server/install-server.sh"
  [ -f "$installer" ] || die "Installer not found at $installer (ref '$ref' may predate it)."
  hdr "Starting the server installer"
  local q_args; q_args="$(printf '%q ' "$@")"
  if [ "$use_sg" = "1" ]; then
    exec sg docker -c "bash $(printf '%q' "$installer") $q_args" <"${tty_in:-/dev/null}"
  fi
  exec bash "$installer" "$@" <"${tty_in:-/dev/null}"
}

main "$@"
