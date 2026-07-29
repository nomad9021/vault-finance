#!/usr/bin/env bash
#
# Vault Finance — interactive server installer (Linux / macOS).
#
# Asks a few questions (where to store data, which port, AI, owner account),
# writes docker/.env, brings up the Docker Compose stack, and — if you want —
# creates your owner account. Safe to re-run: it reads your existing answers
# from docker/.env as defaults.
#
#   bash scripts/install-server.sh
#
# Flags:
#   --dry-run   Show the .env and planned actions without touching Docker.
#   --yes       Accept all defaults / existing values, no prompts (CI/headless).
#
set -euo pipefail

# ---- locate the repo + compose dir -----------------------------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)"
COMPOSE_DIR="$REPO_DIR/docker"
COMPOSE_FILE="$COMPOSE_DIR/docker-compose.yml"
ENV_FILE="$COMPOSE_DIR/.env"

DRY_RUN=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//' | sed '1d'; exit 0 ;;
    *) echo "unknown flag: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# ---- pretty output ----------------------------------------------------------
if [ -t 1 ]; then B=$'\033[1m'; DIM=$'\033[2m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RED=$'\033[31m'; RST=$'\033[0m'; else B= DIM= GRN= YLW= RED= RST=; fi
say()  { printf '%s\n' "$*"; }
hdr()  { printf '\n%s%s%s\n' "$B" "$*" "$RST"; }
ok()   { printf '%s✓%s %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '%s!%s %s\n' "$YLW" "$RST" "$*"; }
die()  { printf '%s✗ %s%s\n' "$RED" "$*" "$RST" >&2; exit 1; }

# ask VAR "Prompt" "default" — reads a line, falls back to default.
ask() {
  local __var="$1" __prompt="$2" __default="${3:-}" __reply=""
  if [ "$ASSUME_YES" = "1" ]; then printf -v "$__var" '%s' "$__default"; return; fi
  if [ -n "$__default" ]; then
    read -r -p "$__prompt ${DIM}[$__default]${RST} " __reply || true
  else
    read -r -p "$__prompt " __reply || true
  fi
  printf -v "$__var" '%s' "${__reply:-$__default}"
}

# ask_secret VAR "Prompt" — hidden input, no default echoed.
ask_secret() {
  local __var="$1" __prompt="$2" __reply=""
  if [ "$ASSUME_YES" = "1" ]; then printf -v "$__var" '%s' ""; return; fi
  read -r -s -p "$__prompt " __reply || true; echo
  printf -v "$__var" '%s' "$__reply"
}

# yesno "Prompt" default(y/n) -> returns 0 for yes
yesno() {
  local __prompt="$1" __default="${2:-n}" __reply=""
  if [ "$ASSUME_YES" = "1" ]; then [ "$__default" = "y" ]; return; fi
  local hint="[y/N]"; [ "$__default" = "y" ] && hint="[Y/n]"
  read -r -p "$__prompt $hint " __reply || true
  __reply="${__reply:-$__default}"
  case "$__reply" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

rand() { # url-safe-ish random token
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 16
  else head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

# json_str "value" -> a safely-quoted JSON string literal (handles \ and ").
json_str() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "$s"
}

# Read an existing value out of docker/.env (for re-run defaults).
envget() {
  local key="$1"
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^${key}=//p" "$ENV_FILE" | head -n1
}

# ---- preflight --------------------------------------------------------------
hdr "Vault Finance server installer"
[ -f "$COMPOSE_FILE" ] || die "Can't find $COMPOSE_FILE — run this from a Vault Finance checkout."

DC=""
if docker compose version >/dev/null 2>&1; then DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"
fi
if [ "$DRY_RUN" != "1" ]; then
  command -v docker >/dev/null 2>&1 || die "Docker isn't installed. See https://docs.docker.com/engine/install/ then re-run."
  [ -n "$DC" ] || die "Docker Compose plugin not found. Install it (https://docs.docker.com/compose/install/) then re-run."
  docker info >/dev/null 2>&1 || die "Docker daemon isn't running (or you lack permission). Start Docker / add yourself to the 'docker' group, then re-run."
  ok "Docker and Compose detected ($DC)"
else
  warn "Dry run — Docker will not be touched."
fi

# ---- questions --------------------------------------------------------------
hdr "1. Where should Vault store its files?"
say "${DIM}Holds the database, uploaded receipts, TLS cert, and (if enabled) AI models.${RST}"
say "${DIM}Use a path on a big/dedicated drive if you have one.${RST}"
DEF_DISK="$(envget VAULT_DISK)"; DEF_DISK="${DEF_DISK:-$COMPOSE_DIR/data}"
ask VAULT_DISK "Data directory:" "$DEF_DISK"
# Resolve to an absolute path so Compose never guesses.
case "$VAULT_DISK" in
  /*) : ;;                                   # already absolute
  ~*) VAULT_DISK="${VAULT_DISK/#\~/$HOME}" ;;
  *)  VAULT_DISK="$COMPOSE_DIR/$VAULT_DISK" ;;
esac

hdr "2. Which HTTPS port should the app listen on?"
DEF_PORT="$(envget VAULT_PORT)"; DEF_PORT="${DEF_PORT:-8443}"
ask VAULT_PORT "Port:" "$DEF_PORT"
[[ "$VAULT_PORT" =~ ^[0-9]+$ ]] || die "Port must be a number (got '$VAULT_PORT')."

hdr "3. Database password"
say "${DIM}Internal to the Docker network. Leave blank to generate a strong random one.${RST}"
DEF_PW="$(envget POSTGRES_PASSWORD)"
if [ -n "$DEF_PW" ]; then
  ask POSTGRES_PASSWORD "Postgres password:" "$DEF_PW"
else
  ask_secret POSTGRES_PASSWORD "Postgres password (blank = random):"
  [ -n "$POSTGRES_PASSWORD" ] || { POSTGRES_PASSWORD="$(rand)"; ok "Generated a random database password."; }
fi

hdr "4. Local AI (optional)"
say "${DIM}Runs an Ollama model on this machine so nothing leaves your hardware.${RST}"
say "${DIM}The app works fully without it; you can turn AI on later in Settings.${RST}"
DEF_MODEL="$(envget OLLAMA_MODEL)"; DEF_MODEL="${DEF_MODEL:-llama3.1:8b}"
PULL_MODEL=""
if yesno "Enable the bundled local AI now?" "n"; then
  ask OLLAMA_MODEL "Model to use:" "$DEF_MODEL"
  PULL_MODEL="$OLLAMA_MODEL"
else
  OLLAMA_MODEL="$DEF_MODEL"
fi

hdr "5. Owner account (optional)"
say "${DIM}Create your login now, or skip and do it from the desktop app's setup wizard.${RST}"
OWNER_EMAIL=""; OWNER_NAME=""; OWNER_PW=""
if yesno "Create the owner account now?" "n"; then
  ask OWNER_EMAIL "  Email:" ""
  ask OWNER_NAME  "  Display name:" ""
  while :; do
    ask_secret OWNER_PW "  Password (min 10 chars):"
    ask_secret OWNER_PW2 "  Confirm password:"
    [ "${#OWNER_PW}" -ge 10 ] || { warn "Too short — at least 10 characters."; continue; }
    [ "$OWNER_PW" = "$OWNER_PW2" ] || { warn "Passwords don't match."; continue; }
    break
  done
fi

# ---- write docker/.env ------------------------------------------------------
POSTGRES_USER="$(envget POSTGRES_USER)"; POSTGRES_USER="${POSTGRES_USER:-vault}"
POSTGRES_DB="$(envget POSTGRES_DB)"; POSTGRES_DB="${POSTGRES_DB:-vault}"

ENV_CONTENT="# Generated by scripts/install-server.sh on $(date -u +%FT%TZ). Edit freely.

# All persistent data lives under this directory.
VAULT_DISK=$VAULT_DISK

# HTTPS port published on the host.
VAULT_PORT=$VAULT_PORT

# Postgres (internal to the compose network).
POSTGRES_USER=$POSTGRES_USER
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
POSTGRES_DB=$POSTGRES_DB

# Local AI (Ollama). OLLAMA_HOST=ollama is the bundled service; point it at
# another machine on your network to use an Ollama running elsewhere.
OLLAMA_HOST=ollama
OLLAMA_PORT=11434
OLLAMA_MODEL=$OLLAMA_MODEL

LOG_LEVEL=info
"

hdr "Review"
say "Configuration to be written to ${B}$ENV_FILE${RST}:"
say "$DIM$ENV_CONTENT$RST"
say "Data directory : ${B}$VAULT_DISK${RST}"
say "Server URL     : ${B}https://localhost:$VAULT_PORT${RST}"
[ -n "$PULL_MODEL" ] && say "Will pull model: ${B}$PULL_MODEL${RST} (this can be several GB)"
[ -n "$OWNER_EMAIL" ] && say "Owner account  : ${B}$OWNER_EMAIL${RST}"

if [ "$DRY_RUN" = "1" ]; then
  echo; ok "Dry run complete — nothing was changed."
  exit 0
fi

echo
yesno "Write this config and start the server?" "y" || die "Aborted — nothing changed."

mkdir -p "$VAULT_DISK"/{postgres,vault,redis,ollama}
printf '%s' "$ENV_CONTENT" > "$ENV_FILE"
ok "Wrote $ENV_FILE"
ok "Created data directories under $VAULT_DISK"

# ---- bring up the stack -----------------------------------------------------
hdr "Building and starting the stack"
say "${DIM}First run compiles the server image and pulls Postgres/Redis/Ollama — give it a few minutes.${RST}"
( cd "$COMPOSE_DIR" && $DC up -d --build )
ok "Containers are up."

# ---- wait for health --------------------------------------------------------
hdr "Waiting for the API to come up"
STATUS_URL="https://localhost:$VAULT_PORT/api/v1/setup/status"
READY=0
for i in $(seq 1 60); do
  if curl -ksf "$STATUS_URL" >/dev/null 2>&1; then READY=1; break; fi
  sleep 2
done
[ "$READY" = "1" ] && ok "API is responding at https://localhost:$VAULT_PORT" \
  || warn "API didn't respond in time. Check: (cd docker && $DC logs -f server)"

# ---- optional owner setup ---------------------------------------------------
if [ -n "$OWNER_EMAIL" ] && [ "$READY" = "1" ]; then
  hdr "Creating your owner account"
  PAYLOAD="{\"ownerEmail\":$(json_str "$OWNER_EMAIL"),\"ownerPassword\":$(json_str "$OWNER_PW"),\"ownerDisplayName\":$(json_str "$OWNER_NAME")}"
  RESP="$(curl -ksS -X POST "https://localhost:$VAULT_PORT/api/v1/setup/complete" \
    -H 'content-type: application/json' \
    --data-binary "$PAYLOAD" || true)"
  if printf '%s' "$RESP" | grep -q 'SETUP_ALREADY_COMPLETE'; then
    warn "An owner account already exists on this server — skipped."
  elif printf '%s' "$RESP" | grep -qi 'error'; then
    warn "Setup responded: $RESP"
  else
    ok "Owner account created for $OWNER_EMAIL"
  fi
fi

# ---- pull AI model ----------------------------------------------------------
if [ -n "$PULL_MODEL" ]; then
  hdr "Pulling AI model: $PULL_MODEL"
  ( cd "$COMPOSE_DIR" && $DC exec -T ollama ollama pull "$PULL_MODEL" ) \
    && ok "Model ready." || warn "Model pull didn't finish — run later: (cd docker && $DC exec ollama ollama pull $PULL_MODEL)"
fi

# ---- summary ----------------------------------------------------------------
LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"; LAN_IP="${LAN_IP:-<this-machine-ip>}"
hdr "${GRN}Done.${RST}"
say "Open the desktop app and connect to one of:"
say "  • Same machine : ${B}https://localhost:$VAULT_PORT${RST}"
say "  • Other devices: ${B}https://$LAN_IP:$VAULT_PORT${RST}"
[ -z "$OWNER_EMAIL" ] && say "\nThe app's setup wizard will create your owner account on first connect."
say "\nUseful commands (from the ${B}docker/${RST} folder):"
say "  ${DIM}$DC ps${RST}          # status"
say "  ${DIM}$DC logs -f server${RST}  # logs"
say "  ${DIM}$DC down${RST}         # stop"
say "\nData lives in ${B}$VAULT_DISK${RST} — back that up. See docs/self-hosting.md."
